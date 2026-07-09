// Разовая настройка Telegram: меню команд + вебхук. Запускать локально после
// деплоя воркера и при смене WEBHOOK_URL/WEBHOOK_SECRET:  `bun run setup`.
//
// Читает BOT_TOKEN / WEBHOOK_URL / WEBHOOK_SECRET из окружения (Bun сам грузит
// .env). WEBHOOK_URL должен указывать на воркер, напр. https://<...>.workers.dev.
// БД скрипту не нужна — импорт bot.ts лишь создаёт libSQL-клиент, но не ходит в неё.

import { config } from "../src/config.ts";
import { bot } from "../src/bot.ts";

// chat_join_request и my_chat_member НЕ входят в набор по умолчанию —
// перечисляем явно, иначе бот не получит заявки и события о правах.
const ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "chat_join_request",
  "my_chat_member",
] as const;

await bot.init();

await bot.api.setMyCommands([
  { command: "channels", description: "Каналы и переключение авто-приёма" },
  { command: "status", description: "Сводка по каналам" },
  { command: "stats", description: "Сколько заявок принято" },
  { command: "help", description: "Справка" },
]);

await bot.api.setWebhook(`${config.webhookUrl}${config.webhookPath}`, {
  secret_token: config.webhookSecret,
  allowed_updates: [...ALLOWED_UPDATES],
});

const info = await bot.api.getWebhookInfo();
console.log(`Бот @${bot.botInfo.username}`);
console.log(`Вебхук установлен: ${info.url}`);
console.log(`Разрешённые апдейты: ${info.allowed_updates?.join(", ") ?? "(по умолчанию)"}`);
console.log(`Ожидают обработки: ${info.pending_update_count}`);
if (info.last_error_message) {
  console.log(`Последняя ошибка доставки: ${info.last_error_message}`);
}
