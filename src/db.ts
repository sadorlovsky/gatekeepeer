// Хранилище на libSQL (@libsql/client). Один клиент работает и с удалённой
// Turso-БД (libsql://…), и с локальным файлом (file:…) для разработки — выбор
// делает config.db. Открываем соединение, накатываем схему и отдаём
// типизированные асинхронные функции доступа. Доступ скоупится по владельцу
// (added_by). libSQL асинхронен, поэтому все функции возвращают Promise.

import { createClient } from "@libsql/client";
import { config } from "./config.ts";

export interface Channel {
  chat_id: number;
  title: string | null;
  type: string | null;
  added_by: number;
  auto_approve: number; // 0 | 1
  active: number; // 0 | 1
  approved_count: number; // all-time счётчик одобренных заявок
  created_at: number;
}

const client = createClient({
  url: config.db.url,
  authToken: config.db.authToken,
});

// PRAGMA-режимы имеют смысл только для локального файла. На Turso журналирование
// и целостность управляются платформой, и эти PRAGMA там игнорируются/недоступны.
if (!config.db.isRemote) {
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA foreign_keys = ON");
}

await client.execute(`
  CREATE TABLE IF NOT EXISTS channels (
    chat_id        INTEGER PRIMARY KEY,
    title          TEXT,
    type           TEXT,
    added_by       INTEGER NOT NULL,
    auto_approve   INTEGER NOT NULL DEFAULT 1,
    active         INTEGER NOT NULL DEFAULT 1,
    approved_count INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
  )
`);

await client.execute(`
  CREATE TABLE IF NOT EXISTS join_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    username     TEXT,
    decision     TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  )
`);

// --- Миграции ---
// CREATE TABLE IF NOT EXISTS не трогает уже существующие таблицы, поэтому БД,
// созданная старой схемой, не получит новых колонок. Догоняем её вручную ДО
// создания индексов: иначе уникальный индекс по requested_at упадёт, а /stats —
// на отсутствующем approved_count. Отдельного механизма миграций нет.

async function tableColumns(table: string): Promise<Set<string>> {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(res.rows.map((r) => String(r.name)));
}

// Журнал мигрируем первым: дедуп должен пройти ДО бэкфилла approved_count,
// иначе счётчик впитает дубли и /stats останется завышенным навсегда.
const joinCols = await tableColumns("join_events");
if (!joinCols.has("requested_at")) {
  await client.execute(`ALTER TABLE join_events ADD COLUMN requested_at INTEGER NOT NULL DEFAULT 0`);
  // Времени подачи у старых строк нет — берём created_at как приближение, чтобы
  // не схлопнуть всю историю пользователя в один (chat_id, user_id, 0).
  await client.execute(`UPDATE join_events SET requested_at = created_at WHERE requested_at = 0`);
  // Дедуп перед уникальным индексом: в старой схеме его не было, дубли возможны.
  // Оставляем строку с минимальным id в каждой группе.
  await client.execute(`
    DELETE FROM join_events
    WHERE id NOT IN (
      SELECT MIN(id) FROM join_events GROUP BY chat_id, user_id, requested_at
    )
  `);
}

const channelCols = await tableColumns("channels");
if (!channelCols.has("approved_count")) {
  await client.execute(`ALTER TABLE channels ADD COLUMN approved_count INTEGER NOT NULL DEFAULT 0`);
  // Бэкфилл all-time счётчика из уже дедуплицированного журнала одобрений.
  await client.execute(`
    UPDATE channels SET approved_count = (
      SELECT COUNT(*) FROM join_events
      WHERE join_events.chat_id = channels.chat_id
        AND join_events.decision = 'approved'
    )
  `);
}

await client.execute(`CREATE INDEX IF NOT EXISTS idx_channels_added_by ON channels(added_by)`);
await client.execute(`CREATE INDEX IF NOT EXISTS idx_join_events_chat ON join_events(chat_id)`);
await client.execute(`CREATE INDEX IF NOT EXISTS idx_join_events_created ON join_events(created_at)`);
// Идемпотентность журнала: одна и та же заявка (chat_id+user_id+время её подачи
// в Telegram) при переобработке вебхука не задвоится.
await client.execute(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_join_events_unique ON join_events(chat_id, user_id, requested_at)`,
);

// --- Каналы ---

const UPSERT_CHANNEL_SQL = `
  INSERT INTO channels (chat_id, title, type, added_by, auto_approve, active, created_at)
  VALUES ($chat_id, $title, $type, $added_by, 1, 1, $created_at)
  ON CONFLICT(chat_id) DO UPDATE SET
    title  = excluded.title,
    type   = excluded.type,
    active = 1
`;

/**
 * Регистрирует канал (или реактивирует уже известный) при добавлении бота админом.
 * Владелец (added_by) — создатель канала (creator), определяется при первой
 * регистрации (см. handlers/chatMember.ts) и НЕ перезаписывается: иначе со-админ,
 * тронувший права бота, перехватил бы контроль над каналом.
 */
export async function upsertChannel(params: {
  chatId: number;
  title: string | null;
  type: string | null;
  addedBy: number;
}): Promise<void> {
  await client.execute({
    sql: UPSERT_CHANNEL_SQL,
    args: {
      chat_id: params.chatId,
      title: params.title,
      type: params.type,
      added_by: params.addedBy,
      created_at: Date.now(),
    },
  });
}

/** Помечает канал неактивным (бота убрали или понизили). */
export async function deactivateChannel(chatId: number): Promise<void> {
  await client.execute({
    sql: `UPDATE channels SET active = 0 WHERE chat_id = $chat_id`,
    args: { chat_id: chatId },
  });
}

export async function getChannel(chatId: number): Promise<Channel | null> {
  const res = await client.execute({
    sql: `SELECT * FROM channels WHERE chat_id = $chat_id`,
    args: { chat_id: chatId },
  });
  const row = res.rows[0];
  return row ? (row as unknown as Channel) : null;
}

/** Каналы пользователя (только активные). */
export async function listChannelsByOwner(ownerId: number): Promise<Channel[]> {
  const res = await client.execute({
    sql: `SELECT * FROM channels WHERE added_by = $owner AND active = 1 ORDER BY created_at`,
    args: { owner: ownerId },
  });
  return res.rows as unknown as Channel[];
}

/**
 * Переключает авто-приём. Меняет строку только если канал принадлежит ownerId.
 * Возвращает true, если запись действительно изменена.
 */
export async function setAutoApprove(
  chatId: number,
  ownerId: number,
  value: boolean,
): Promise<boolean> {
  const res = await client.execute({
    sql: `UPDATE channels SET auto_approve = $value WHERE chat_id = $chat_id AND added_by = $owner`,
    args: { chat_id: chatId, owner: ownerId, value: value ? 1 : 0 },
  });
  return res.rowsAffected > 0;
}

// --- Журнал заявок ---

const INSERT_JOIN_SQL = `
  INSERT OR IGNORE INTO join_events (chat_id, user_id, username, decision, requested_at, created_at)
  VALUES ($chat_id, $user_id, $username, $decision, $requested_at, $created_at)
`;

const BUMP_APPROVED_SQL = `UPDATE channels SET approved_count = approved_count + 1 WHERE chat_id = $chat_id`;

export async function logJoin(params: {
  chatId: number;
  userId: number;
  username: string | null;
  decision: "approved" | "declined";
  /** Время подачи заявки из Telegram (chat_join_request.date), секунды. */
  requestedAt: number;
}): Promise<void> {
  // Лог + инкремент all-time счётчика атомарно в одной транзакции. Счётчик растёт
  // только если запись действительно вставлена (INSERT OR IGNORE дал rowsAffected
  // > 0) — повторная доставка той же заявки вебхуком не накрутит статистику.
  const tx = await client.transaction("write");
  try {
    const res = await tx.execute({
      sql: INSERT_JOIN_SQL,
      args: {
        chat_id: params.chatId,
        user_id: params.userId,
        username: params.username,
        decision: params.decision,
        requested_at: params.requestedAt,
        created_at: Date.now(),
      },
    });
    if (res.rowsAffected > 0 && params.decision === "approved") {
      await tx.execute({ sql: BUMP_APPROVED_SQL, args: { chat_id: params.chatId } });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export interface OwnerStat {
  chat_id: number;
  title: string | null;
  approved: number;
}

/** Сводка принятых заявок по каналам пользователя (all-time, из счётчика). */
export async function statsByOwner(ownerId: number): Promise<OwnerStat[]> {
  const res = await client.execute({
    sql: `
      SELECT chat_id, title, approved_count AS approved
      FROM channels
      WHERE added_by = $owner AND active = 1
      ORDER BY created_at
    `,
    args: { owner: ownerId },
  });
  return res.rows as unknown as OwnerStat[];
}

/**
 * Чистит журнал заявок старше olderThanMs. На all-time статистику (/stats)
 * не влияет — она считается по channels.approved_count, а не по журналу.
 * Возвращает число удалённых строк.
 */
export async function pruneJoinEvents(olderThanMs: number): Promise<number> {
  const res = await client.execute({
    sql: `DELETE FROM join_events WHERE created_at < $cutoff`,
    args: { cutoff: Date.now() - olderThanMs },
  });
  return res.rowsAffected;
}
