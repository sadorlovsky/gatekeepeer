// Дешёвый пре-фильтр перед вызовом LLM: отсекаем заведомо безобидные сообщения,
// чтобы к платной классификации доходила лишь малая доля трафика. Эвристики
// САМИ не удаляют — они лишь решают, эскалировать ли сообщение к LLM-судье.
// Помимо классики (ссылки, упоминания) учитываем метаданные спама: эмодзи-флуд,
// смешение алфавитов (обфускация), разбиение текста пробелами, форварды, кнопки,
// медиа без подписи, высокая плотность ссылок.

import type { Channel } from "../db.ts";

// Ссылки (http/https, t.me) и @-упоминания длиной от 3 символов.
const SUSPICIOUS_RE = /(https?:\/\/|t\.me\/|@\w{3,})/i;

// Пороги (именованные — легко тюнить).
const EMOJI_THRESHOLD = 5; // больше — сигнал эмодзи-флуда
const LINK_DENSITY_ABS = 3; // столько ссылочных сущностей — сигнал
const SPACING_MIN_TOKENS = 6; // меньше токенов — abnormal spacing не считаем
const SPACING_SINGLE_RATIO = 0.5; // доля односимвольных токенов выше — сигнал

// Структурный минимум сообщения, который читают эвристики. Подходит и для
// Message (группы), и для channel_post, и для тестовых литералов; все поля
// опциональны — отсутствие сигнала не ошибка.
export interface ModeratableMessage {
  text?: string;
  caption?: string;
  entities?: { type: string }[];
  caption_entities?: { type: string }[];
  forward_origin?: unknown;
  reply_markup?: { inline_keyboard?: unknown[][] };
  photo?: unknown[];
  video?: unknown;
  document?: unknown;
}

/** Число эмодзи в тексте (Extended_Pictographic). */
export function countEmoji(text: string): number {
  return text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
}

/**
 * Смешение латиницы и кириллицы ВНУТРИ одного слова — классическая обфускация
 * («kупить», «pассылка»). Проверяем по словам, а не по всему тексту, иначе
 * нормальный двуязычный текст с раздельными словами дал бы ложное срабатывание.
 */
export function hasMixedScripts(text: string): boolean {
  const words = text.match(/[\p{L}]+/gu);
  if (!words) return false;
  return words.some(
    (w) => /\p{Script=Latin}/u.test(w) && /\p{Script=Cyrillic}/u.test(w),
  );
}

/**
 * Текст искусственно разбит пробелами по буквам («к у п и т ь») — приём обхода
 * фильтров. Считаем долю односимвольных токенов; при достаточном числе токенов
 * и высокой доле — сигнал.
 */
export function abnormalSpacing(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < SPACING_MIN_TOKENS) return false;
  const single = tokens.filter((t) => [...t].length === 1).length;
  return single / tokens.length > SPACING_SINGLE_RATIO;
}

/** Число ссылочных сущностей (url/text_link/mention) в сообщении. */
export function linkDensity(
  entities: { type: string }[] | undefined,
  _textLength: number,
): number {
  if (!entities) return 0;
  return entities.filter(
    (e) => e.type === "url" || e.type === "text_link" || e.type === "mention",
  ).length;
}

/** Стоит ли отправлять сообщение на LLM-классификацию. */
export function shouldClassify(msg: ModeratableMessage, channel: Channel): boolean {
  if (channel.moderation_enabled === 0) return false;

  const text = (msg.text ?? msg.caption ?? "").trim();
  const entities = msg.entities ?? msg.caption_entities;
  const hasMedia = Boolean(msg.photo || msg.video || msg.document);

  // Медиа без подписи — отдельный сигнал (раньше отсекалось на пустом тексте).
  if (hasMedia && !text) return true;

  if (!text) return false;
  if (text.length < 8 && !hasMedia) return false;

  // Классика: ссылки и @-упоминания в тексте.
  if (SUSPICIOUS_RE.test(text)) return true;

  // Метаданные-сигналы → эскалация к LLM (не удаление).
  if (msg.forward_origin) return true;
  if (msg.reply_markup?.inline_keyboard?.length) return true;
  if (countEmoji(text) > EMOJI_THRESHOLD) return true;
  if (hasMixedScripts(text)) return true;
  if (abnormalSpacing(text)) return true;
  if (linkDensity(entities, text.length) >= LINK_DENSITY_ABS) return true;

  return false;
}
