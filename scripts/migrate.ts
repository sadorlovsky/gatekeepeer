// Разовое применение схемы БД (идемпотентно). Локально/CI:  `bun run migrate`.
// Для Turso задай TURSO_DATABASE_URL / TURSO_AUTH_TOKEN в окружении (.env);
// без них применяется к локальному файлу из DB_PATH.
//
// На проде обычно не нужен (схема в Turso уже есть), но безопасен к повторному
// запуску: все операции — IF NOT EXISTS / условные ALTER.

import { migrate } from "../src/db.ts";
import { config } from "../src/config.ts";

await migrate();
console.log(`Схема применена: ${config.db.isRemote ? "Turso" : config.db.url}`);
