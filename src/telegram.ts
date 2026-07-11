// Обвязка Telegram: меню команд + вебхук с нужным набором апдейтов.
// Идемпотентно. Зовётся разово из scripts/setup.ts и периодически из
// scheduled() (само-восстановление, если вебхук слетел после /revoke токена
// или забыли `bun run setup`). Один источник правды для ALLOWED_UPDATES и команд.

import type { Bot } from "grammy";
import { config } from "./config.ts";

// chat_join_request и my_chat_member НЕ входят в набор по умолчанию —
// перечисляем явно, иначе бот не получит заявки и события о правах.
export const ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "chat_join_request",
  "my_chat_member",
] as const;

const COMMANDS = [
  { command: "channels", description: "Каналы и переключение авто-приёма" },
  { command: "status", description: "Сводка по каналам" },
  { command: "stats", description: "Сколько заявок принято" },
  { command: "help", description: "Справка" },
];

/** Идемпотентно выставляет меню команд и вебхук Telegram на config.webhookUrl. */
export async function configureTelegram(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(COMMANDS);
  await bot.api.setWebhook(`${config.webhookUrl}${config.webhookPath}`, {
    secret_token: config.webhookSecret,
    allowed_updates: [...ALLOWED_UPDATES],
  });
}
