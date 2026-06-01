// Чтение и валидация переменных окружения. Bun сам подхватывает .env.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Не задана обязательная переменная окружения ${name} (см. .env.example)`,
    );
  }
  return value;
}

// Секрет вебхука — единственная защита от поддельных апдейтов: кто угадает
// заголовок, тот шлёт боту что угодно. Требуем длину >= 32 и charset, который
// допускает сам Telegram для secret_token (A-Z a-z 0-9 _ -).
function requiredSecret(name: string): string {
  const value = required(name);
  if (value.length < 32 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(
      `${name} должен быть не короче 32 символов и содержать только A-Z a-z 0-9 _ - (см. .env.example)`,
    );
  }
  return value;
}

// Подключение к БД через libSQL: либо удалённая Turso (libsql://… + токен),
// либо локальный файл (file:…) для разработки. Если TURSO_DATABASE_URL задан —
// идём в Turso; иначе откатываемся на локальный SQLite-файл из DB_PATH.
// Так dev-режим работает без всякой облачной конфигурации.
function buildDbConfig(): {
  url: string;
  authToken?: string;
  isRemote: boolean;
} {
  const remoteUrl = process.env.TURSO_DATABASE_URL?.trim();
  if (remoteUrl) {
    const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
    // Сетевые схемы требуют токена аутентификации; file: — нет.
    const isRemote = /^(libsql|https?|wss?):\/\//.test(remoteUrl);
    if (isRemote && !authToken) {
      throw new Error(
        "Для удалённой БД (TURSO_DATABASE_URL) нужен TURSO_AUTH_TOKEN (см. .env.example)",
      );
    }
    return { url: remoteUrl, authToken, isRemote };
  }
  // Локальная разработка: файл SQLite через схему file:.
  const dbPath = process.env.DB_PATH ?? "gatekeepeer.sqlite";
  return { url: `file:${dbPath}`, isRemote: false };
}

// LLM для модерации спама. Используем OpenAI-compatible протокол
// (POST {baseUrl}/chat/completions): подходит OpenAI, OpenRouter, локальная модель.
// Всё опционально — без ключа модуль модерации не подключается.
const llmApiKey = process.env.LLM_API_KEY?.trim();

// Целое число из env с мягкой деградацией: кривой/отрицательный ввод не валит
// бота на старте (фичи модерации опциональны), а откатывается на дефолт.
function posIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.warn(`${name}=${raw} некорректно (нужно целое >= 1), используем ${fallback}`);
    return fallback;
  }
  return n;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  webhookUrl: required("WEBHOOK_URL").replace(/\/+$/, ""),
  webhookSecret: requiredSecret("WEBHOOK_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  db: buildDbConfig(),
  // Путь, по которому сервер принимает апдейты от Telegram.
  webhookPath: "/webhook",
  llm: {
    apiKey: llmApiKey,
    baseUrl: (process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.LLM_MODEL?.trim() || "gpt-4o-mini",
  },
  // Модерация включается только при заданном ключе LLM.
  moderationEnabled: Boolean(llmApiKey),
  // Внешний blocklist Combot Anti-Spam (CAS): дешёвый отсев известных спамеров
  // по user_id перед дорогим LLM. Включён по умолчанию, отключается CAS_ENABLED=false.
  cas: {
    enabled: process.env.CAS_ENABLED !== "false",
    apiUrl: process.env.CAS_API_URL?.trim() || "https://api.cas.chat/check",
    timeoutMs: posIntEnv("CAS_TIMEOUT_MS", 3000),
  },
  moderation: {
    // Сколько первых сообщений новичка проверяем, прежде чем считать его
    // доверенным и пропускать модерацию (экономия LLM-вызовов).
    firstMessages: posIntEnv("MODERATION_FIRST_MESSAGES", 3),
  },
} as const;
