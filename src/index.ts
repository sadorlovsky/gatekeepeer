// Точка входа Cloudflare Worker.
//   fetch()     — приём апдейтов Telegram вебхуком (POST /webhook) и /health.
//   scheduled() — дневная чистка журнала заявок (Cron Trigger, см. wrangler.toml).
// Воркер полностью stateless: весь стейт во внешней Turso. Разовая настройка
// Telegram (setWebhook / setMyCommands) вынесена в scripts/setup.ts и в рантайме
// НЕ выполняется — на Workers нет «старта», а сеть в global scope запрещена.

import { webhookCallback } from "grammy";
import { config } from "./config.ts";
import { bot } from "./bot.ts";
import { pruneJoinEvents } from "./db.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Сколько держим записи журнала заявок. На /stats не влияет (all-time счётчик
// в channels), журнал нужен лишь как недавняя история.
const JOIN_EVENTS_RETENTION_MS = 90 * DAY_MS;

// Апдейты Telegram заведомо небольшие; отсекаем заведомо мусорные тела до парсинга.
const MAX_WEBHOOK_BODY = 1024 * 1024; // 1 МБ

// grammY лениво инициализирует бота (getMe) при первом апдейте и сам проверяет
// секретный заголовок X-Telegram-Bot-Api-Secret-Token (иначе 401).
const handleUpdate = webhookCallback(bot, "cloudflare-mod", {
  secretToken: config.webhookSecret,
});

// Минимальный тип контекста воркера — только то, что используем (без зависимости
// от @cloudflare/workers-types, чтобы не конфликтовать с bun-types в тестах).
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === config.webhookPath) {
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > MAX_WEBHOOK_BODY) {
        return new Response("payload too large", { status: 413 });
      }
      try {
        return await handleUpdate(request);
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

  // Cron Trigger: раз в сутки чистим журнал заявок старше ретеншена. waitUntil
  // держит воркер живым до конца удаления, не блокируя возврат из хендлера.
  async scheduled(_event: unknown, _env: unknown, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      pruneJoinEvents(JOIN_EVENTS_RETENTION_MS).then((removed) => {
        if (removed > 0) console.log(`Очищено старых записей журнала: ${removed}`);
      }),
    );
  },
};
