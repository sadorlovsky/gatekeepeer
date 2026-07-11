// Разовая настройка Telegram: меню команд + вебхук. Запускать локально после
// деплоя воркера и при смене WEBHOOK_URL/WEBHOOK_SECRET:  `bun run setup`.
//
// ВАЖНО: /revoke токена в BotFather СБРАСЫВАЕТ вебхук (url становится пустым, бот
// перестаёт получать апдейты). После любой ротации токена обязательно прогони
// этот скрипт заново, иначе бот замолчит.
//
// Читает BOT_TOKEN / WEBHOOK_URL / WEBHOOK_SECRET из окружения (Bun сам грузит
// .env). WEBHOOK_URL должен указывать на воркер, напр. https://<...>.workers.dev.
// БД скрипту не нужна — импорт bot.ts лишь создаёт libSQL-клиент, но не ходит в неё.

import { bot } from "../src/bot.ts";
import { configureTelegram } from "../src/telegram.ts";

await bot.init();
await configureTelegram(bot);

const info = await bot.api.getWebhookInfo();
console.log(`Бот @${bot.botInfo.username}`);
console.log(`Вебхук установлен: ${info.url}`);
console.log(`Разрешённые апдейты: ${info.allowed_updates?.join(", ") ?? "(по умолчанию)"}`);
console.log(`Ожидают обработки: ${info.pending_update_count}`);
if (info.last_error_message) {
  console.log(`Последняя ошибка доставки: ${info.last_error_message}`);
}
