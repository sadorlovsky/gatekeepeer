// Сборка inline-клавиатур для пульта в личке.

import { InlineKeyboard } from "grammy";
import type { Channel } from "./db.ts";

export const TOGGLE_PREFIX = "toggle";

/** Клавиатура списка каналов: по кнопке на канал, тап переключает авто-приём. */
export function channelsKeyboard(channels: Channel[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const ch of channels) {
    const mark = ch.auto_approve ? "✅" : "⛔️";
    const title = ch.title ?? String(ch.chat_id);
    kb.text(`${mark} ${title}`, `${TOGGLE_PREFIX}:${ch.chat_id}`).row();
  }
  return kb;
}
