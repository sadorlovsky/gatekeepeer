// Сборка inline-клавиатур для пульта в личке.

import { InlineKeyboard } from "grammy";
import type { Channel } from "./db.ts";

// Префиксы callback_data. Формат: verb[:chatId[:arg]]. Telegram ограничивает
// callback_data 64 байтами — наши схемы укладываются с запасом.
export const TOGGLE_PREFIX = "toggle"; // вкл/выкл мастер-приём
export const LIST_PREFIX = "list"; // назад к списку каналов
export const OPEN_PREFIX = "ch"; // открыть экран канала
export const MODE_PREFIX = "mode"; // выбрать режим заявок
export const MOD_PREFIX = "mod"; // вкл/выкл модерацию
export const CAP_PREFIX = "cap"; // капча-кнопка в личке заявителя

/** Глиф статуса канала для подписи в списке. */
function statusGlyph(ch: Channel): string {
  if (ch.auto_approve === 0) return "⏸️";
  switch (ch.join_mode) {
    case "decline":
      return "🚫";
    case "captcha":
      return "🤖";
    default:
      return "✅";
  }
}

/** Список каналов: по кнопке на канал, тап открывает экран настроек канала. */
export function channelsKeyboard(channels: Channel[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const ch of channels) {
    const title = ch.title ?? String(ch.chat_id);
    kb.text(`${statusGlyph(ch)} ${title}`, `${OPEN_PREFIX}:${ch.chat_id}`).row();
  }
  return kb;
}

const MODE_LABEL: Record<string, string> = {
  approve: "Авто-приём",
  decline: "Авто-отклонение",
  captcha: "Проверка (капча)",
};

/** Текст экрана отдельного канала. */
export function channelDetailText(ch: Channel): string {
  const title = ch.title ?? String(ch.chat_id);
  const lines = [
    `Канал «${title}»`,
    `Статус: ${ch.active ? "активен" : "отключён"}`,
    `Авто-приём: ${ch.auto_approve ? "вкл ✅" : "выкл ⛔️"}`,
    `Режим заявок: ${MODE_LABEL[ch.join_mode] ?? ch.join_mode}`,
    `Принято заявок: ${ch.approved_count}`,
    `Модерация спама: ${ch.moderation_enabled ? "вкл 🛡" : "выкл"}`,
  ];
  return lines.join("\n");
}

/** Клавиатура экрана канала: тогглы и выбор режима. */
export function channelDetailKeyboard(ch: Channel): InlineKeyboard {
  const id = ch.chat_id;
  const kb = new InlineKeyboard();

  // Мастер-выключатель приёма.
  kb.text(
    ch.auto_approve ? "⛔️ Выключить приём" : "✅ Включить приём",
    `${TOGGLE_PREFIX}:${id}`,
  ).row();

  // Выбор режима (активный помечен точкой).
  const dot = (mode: string) => (ch.join_mode === mode ? "• " : "");
  kb.text(`${dot("approve")}✅ Приём`, `${MODE_PREFIX}:${id}:approve`)
    .text(`${dot("decline")}🚫 Отклонять`, `${MODE_PREFIX}:${id}:decline`)
    .text(`${dot("captcha")}🤖 Капча`, `${MODE_PREFIX}:${id}:captcha`)
    .row();

  // Модерация спама.
  kb.text(
    ch.moderation_enabled ? "🛡 Модерация: выкл" : "🛡 Модерация: вкл",
    `${MOD_PREFIX}:${id}`,
  ).row();

  kb.text("« Назад", LIST_PREFIX);
  return kb;
}

/** Кнопка капчи в личке заявителя; несёт chat_id канала для одобрения по колбэку. */
export function captchaKeyboard(chatId: number): InlineKeyboard {
  return new InlineKeyboard().text("Я не робот ✅", `${CAP_PREFIX}:${chatId}`);
}
