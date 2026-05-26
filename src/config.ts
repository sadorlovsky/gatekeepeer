// Чтение и валидация переменных окружения. Bun сам подхватывает .env.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
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

export const config = {
  botToken: required("BOT_TOKEN"),
  webhookUrl: required("WEBHOOK_URL").replace(/\/+$/, ""),
  webhookSecret: requiredSecret("WEBHOOK_SECRET"),
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "housekeeper.sqlite",
  // Путь, по которому сервер принимает апдейты от Telegram.
  webhookPath: "/webhook",
} as const;
