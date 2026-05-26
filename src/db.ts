// Хранилище на bun:sqlite. Открываем БД, накатываем схему и отдаём
// типизированные функции доступа. Доступ скоупится по владельцу (added_by).

import { Database } from "bun:sqlite";
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

const db = new Database(config.dbPath, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

db.run(`
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

db.run(`
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

function tableColumns(table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

// Журнал мигрируем первым: дедуп должен пройти ДО бэкфилла approved_count,
// иначе счётчик впитает дубли и /stats останется завышенным навсегда.
const joinCols = tableColumns("join_events");
if (!joinCols.has("requested_at")) {
  db.run(`ALTER TABLE join_events ADD COLUMN requested_at INTEGER NOT NULL DEFAULT 0`);
  // Времени подачи у старых строк нет — берём created_at как приближение, чтобы
  // не схлопнуть всю историю пользователя в один (chat_id, user_id, 0).
  db.run(`UPDATE join_events SET requested_at = created_at WHERE requested_at = 0`);
  // Дедуп перед уникальным индексом: в старой схеме его не было, дубли возможны.
  // Оставляем строку с минимальным id в каждой группе.
  db.run(`
    DELETE FROM join_events
    WHERE id NOT IN (
      SELECT MIN(id) FROM join_events GROUP BY chat_id, user_id, requested_at
    )
  `);
}

const channelCols = tableColumns("channels");
if (!channelCols.has("approved_count")) {
  db.run(`ALTER TABLE channels ADD COLUMN approved_count INTEGER NOT NULL DEFAULT 0`);
  // Бэкфилл all-time счётчика из уже дедуплицированного журнала одобрений.
  db.run(`
    UPDATE channels SET approved_count = (
      SELECT COUNT(*) FROM join_events
      WHERE join_events.chat_id = channels.chat_id
        AND join_events.decision = 'approved'
    )
  `);
}

db.run(`CREATE INDEX IF NOT EXISTS idx_channels_added_by ON channels(added_by)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_join_events_chat ON join_events(chat_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_join_events_created ON join_events(created_at)`);
// Идемпотентность журнала: одна и та же заявка (chat_id+user_id+время её подачи
// в Telegram) при переобработке вебхука не задвоится.
db.run(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_join_events_unique ON join_events(chat_id, user_id, requested_at)`,
);

// --- Каналы ---

const upsertChannelStmt = db.query(`
  INSERT INTO channels (chat_id, title, type, added_by, auto_approve, active, created_at)
  VALUES ($chat_id, $title, $type, $added_by, 1, 1, $created_at)
  ON CONFLICT(chat_id) DO UPDATE SET
    title  = excluded.title,
    type   = excluded.type,
    active = 1
`);

/**
 * Регистрирует канал (или реактивирует уже известный) при добавлении бота админом.
 * Владелец (added_by) — создатель канала (creator), определяется при первой
 * регистрации (см. handlers/chatMember.ts) и НЕ перезаписывается: иначе со-админ,
 * тронувший права бота, перехватил бы контроль над каналом.
 */
export function upsertChannel(params: {
  chatId: number;
  title: string | null;
  type: string | null;
  addedBy: number;
}): void {
  upsertChannelStmt.run({
    $chat_id: params.chatId,
    $title: params.title,
    $type: params.type,
    $added_by: params.addedBy,
    $created_at: Date.now(),
  });
}

const deactivateChannelStmt = db.query(
  `UPDATE channels SET active = 0 WHERE chat_id = $chat_id`,
);

/** Помечает канал неактивным (бота убрали или понизили). */
export function deactivateChannel(chatId: number): void {
  deactivateChannelStmt.run({ $chat_id: chatId });
}

const getChannelStmt = db.query<Channel, { $chat_id: number }>(
  `SELECT * FROM channels WHERE chat_id = $chat_id`,
);

export function getChannel(chatId: number): Channel | null {
  return getChannelStmt.get({ $chat_id: chatId });
}

const listChannelsByOwnerStmt = db.query<Channel, { $owner: number }>(
  `SELECT * FROM channels WHERE added_by = $owner AND active = 1 ORDER BY created_at`,
);

/** Каналы пользователя (только активные). */
export function listChannelsByOwner(ownerId: number): Channel[] {
  return listChannelsByOwnerStmt.all({ $owner: ownerId });
}

const setAutoApproveStmt = db.query(
  `UPDATE channels SET auto_approve = $value WHERE chat_id = $chat_id AND added_by = $owner`,
);

/**
 * Переключает авто-приём. Меняет строку только если канал принадлежит ownerId.
 * Возвращает true, если запись действительно изменена.
 */
export function setAutoApprove(chatId: number, ownerId: number, value: boolean): boolean {
  const res = setAutoApproveStmt.run({
    $chat_id: chatId,
    $owner: ownerId,
    $value: value ? 1 : 0,
  });
  return res.changes > 0;
}

// --- Журнал заявок ---

const insertJoinStmt = db.query(`
  INSERT OR IGNORE INTO join_events (chat_id, user_id, username, decision, requested_at, created_at)
  VALUES ($chat_id, $user_id, $username, $decision, $requested_at, $created_at)
`);

const bumpApprovedStmt = db.query(
  `UPDATE channels SET approved_count = approved_count + 1 WHERE chat_id = $chat_id`,
);

// Лог + инкремент all-time счётчика атомарно. Счётчик растёт только если запись
// действительно вставлена (INSERT OR IGNORE вернул changes > 0) — повторная
// доставка той же заявки вебхуком не накрутит статистику.
const logJoinTxn = db.transaction(
  (params: {
    chatId: number;
    userId: number;
    username: string | null;
    decision: "approved" | "declined";
    requestedAt: number;
  }) => {
    const res = insertJoinStmt.run({
      $chat_id: params.chatId,
      $user_id: params.userId,
      $username: params.username,
      $decision: params.decision,
      $requested_at: params.requestedAt,
      $created_at: Date.now(),
    });
    if (res.changes > 0 && params.decision === "approved") {
      bumpApprovedStmt.run({ $chat_id: params.chatId });
    }
  },
);

export function logJoin(params: {
  chatId: number;
  userId: number;
  username: string | null;
  decision: "approved" | "declined";
  /** Время подачи заявки из Telegram (chat_join_request.date), секунды. */
  requestedAt: number;
}): void {
  logJoinTxn(params);
}

export interface OwnerStat {
  chat_id: number;
  title: string | null;
  approved: number;
}

const statsByOwnerStmt = db.query<OwnerStat, { $owner: number }>(`
  SELECT chat_id, title, approved_count AS approved
  FROM channels
  WHERE added_by = $owner AND active = 1
  ORDER BY created_at
`);

/** Сводка принятых заявок по каналам пользователя (all-time, из счётчика). */
export function statsByOwner(ownerId: number): OwnerStat[] {
  return statsByOwnerStmt.all({ $owner: ownerId });
}

const pruneJoinEventsStmt = db.query(
  `DELETE FROM join_events WHERE created_at < $cutoff`,
);

/**
 * Чистит журнал заявок старше olderThanMs. На all-time статистику (/stats)
 * не влияет — она считается по channels.approved_count, а не по журналу.
 * Возвращает число удалённых строк.
 */
export function pruneJoinEvents(olderThanMs: number): number {
  const res = pruneJoinEventsStmt.run({ $cutoff: Date.now() - olderThanMs });
  return res.changes;
}
