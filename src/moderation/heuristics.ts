// Дешёвый пре-фильтр перед вызовом LLM: отсекаем заведомо безобидные сообщения,
// чтобы к платной классификации доходила лишь малая доля трафика. Основной
// носитель спама в чатах — ссылки и упоминания, поэтому классифицируем только их.

import type { Channel } from "../db.ts";

// Ссылки (http/https, t.me) и @-упоминания длиной от 3 символов.
const SUSPICIOUS_RE = /(https?:\/\/|t\.me\/|@\w{3,})/i;

/** Стоит ли отправлять сообщение на LLM-классификацию. */
export function shouldClassify(text: string | undefined | null, channel: Channel): boolean {
  if (channel.moderation_enabled === 0) return false;
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  return SUSPICIOUS_RE.test(trimmed);
}
