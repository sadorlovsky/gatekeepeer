// Точка входа: поднимаем HTTP-сервер на Bun.serve и принимаем апдейты вебхуком.

import { webhookCallback } from "grammy";
import { config } from "./config.ts";
import { bot } from "./bot.ts";
import { pruneJoinEvents } from "./db.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Сколько держим записи журнала заявок. На /stats не влияет (all-time счётчик
// в channels), журнал нужен лишь как недавняя история.
const JOIN_EVENTS_RETENTION_MS = 90 * DAY_MS;

// Важно: chat_join_request и my_chat_member НЕ входят в набор по умолчанию —
// перечисляем их явно, иначе бот не получит заявки.
const ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "chat_join_request",
  "my_chat_member",
] as const;

const handleUpdate = webhookCallback(bot, "std/http", {
  secretToken: config.webhookSecret,
});

// Апдейты Telegram заведомо меньше; отсекаем заведомо мусорные тела до парсинга.
// Полноценный rate-limit — задача reverse proxy перед сервисом.
const MAX_WEBHOOK_BODY = 1024 * 1024; // 1 МБ

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
console.log(`Бот @${bot.botInfo.username} запущен.`);
console.log(`Вебхук: ${info.url}`);
console.log(`Разрешённые апдейты: ${info.allowed_updates?.join(", ") ?? "(по умолчанию)"}`);
console.log(`Ожидают обработки: ${info.pending_update_count}`);

// Ретеншен журнала: разово на старте и далее раз в сутки.
await pruneJoinEvents(JOIN_EVENTS_RETENTION_MS);
setInterval(async () => {
  const removed = await pruneJoinEvents(JOIN_EVENTS_RETENTION_MS);
  if (removed > 0) console.log(`Очищено старых записей журнала: ${removed}`);
}, DAY_MS);

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === config.webhookPath) {
      const contentLength = Number(req.headers.get("content-length") ?? 0);
      if (contentLength > MAX_WEBHOOK_BODY) {
        return new Response("payload too large", { status: 413 });
      }
      try {
        return await handleUpdate(req);
      } catch (err) {
        console.error("Ошибка обработки вебхука:", err);
        return new Response("error", { status: 500 });
      }
    }
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`HTTP-сервер слушает порт ${server.port}, путь ${config.webhookPath}`);
