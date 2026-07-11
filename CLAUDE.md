# CLAUDE.md

Telegram-бот авто-приёма заявок на вступление в приватные каналы/чаты.
Мультиарендный: любой добавляет бота админом в свой канал и становится
владельцем его настроек. Личка с ботом — пульт управления, каждый видит только
свои каналы.

## Стек и запуск

- **TypeScript + [grammY](https://grammy.dev) + libSQL ([@libsql/client](https://docs.turso.tech))**, апдейты через **webhook** (не long-polling). Хостинг — **Cloudflare Workers** (раньше был Fly.io/Bun). БД — Turso в проде, локальный файл SQLite (`file:…`) в разработке; клиент один и тот же, выбор делает `config.db`.
- `bun run dev` — локальный воркер через `wrangler dev`.
- `bun run deploy` — деплой воркера (`wrangler deploy`).
- `bun run setup` — разово выставляет меню команд и вебхук Telegram на адрес из
  `WEBHOOK_URL` (см. `scripts/setup.ts`). Запускать после деплоя / смены URL.
- `bun run migrate` — идемпотентно накатывает схему БД (`scripts/migrate.ts`);
  на проде обычно не нужен (схема в Turso уже есть).
- `bun run tail` — живые логи воркера (`wrangler tail`).
- `bunx tsc --noEmit` — проверка типов (есть `noEmit`, эмита нет — только typecheck).
- `bun test` — тесты (`test/app.test.ts`): интеграционно проверяют поток через
  хендлеры и БД на временной SQLite (миграции, скоуп по владельцу, идемпотентность
  журнала, команды/колбэки, регистрация на creator). Тесты сами зовут `db.migrate()`
  перед проверками. `bun test --coverage` — покрытие. Линтера в проекте нет.

В бандле воркера `@libsql/client` подменяется на `@libsql/client/web` (HTTP-клиент
без нативных биндингов) через `[alias]` в `wrangler.toml`. Секреты и vars воркера
доступны в `process.env` благодаря флагу `nodejs_compat`, поэтому `config.ts` не
меняется. Вебхуку нужен публичный HTTPS — в проде это `*.workers.dev`; локально
подними туннель (`cloudflared`/`ngrok`) и положи его адрес в `WEBHOOK_URL`.

## Конфигурация (`.env`, читается Bun автоматически)

- `BOT_TOKEN` — токен от BotFather (обязателен).
- `WEBHOOK_URL` — публичный https-адрес (обязателен).
- `WEBHOOK_SECRET` — секрет для проверки апдейтов (обязателен).
- `TURSO_DATABASE_URL` — адрес Turso-БД (`libsql://…`). Если задан — работаем с
  Turso; иначе откатываемся на локальный файл из `DB_PATH`.
- `TURSO_AUTH_TOKEN` — токен Turso. Обязателен, когда `TURSO_DATABASE_URL` —
  сетевой адрес (`libsql`/`https`/`wss`); для `file:` не нужен.
- `DB_PATH` — путь к локальному SQLite-файлу для разработки, по умолчанию
  `gatekeepeer.sqlite`. Используется только когда `TURSO_DATABASE_URL` пуст.

Валидация в `src/config.ts`: отсутствие обязательной переменной кидает ошибку на старте.

## Архитектура

```
src/
  config.ts            конфиг из .env с валидацией
  db.ts                bun:sqlite: схема + типизированные функции доступа
  bot.ts               сборка Bot и регистрация всех хендлеров
  keyboards.ts         inline-клавиатуры
  handlers/
    joinRequest.ts     chat_join_request — тихий приём заявок
    chatMember.ts      my_chat_member — авто-регистрация/деактивация канала
    commands.ts        /start /help /channels /status /stats
    callbacks.ts       inline-кнопки: переключение авто-приёма
  telegram.ts          обвязка Telegram: configureTelegram (команды + вебхук), ALLOWED_UPDATES
  index.ts             Worker: fetch() (webhook + /health) + scheduled() (чистка + само-восстановление)
scripts/
  setup.ts             разово: configureTelegram (setMyCommands + setWebhook)
  migrate.ts           разово: накат схемы БД
```

Поток данных: `index.ts` (fetch/webhook) → `bot.ts` (роутинг grammY) → хендлеры → `db.ts`.

## Ключевые инварианты

- **Скоуп по владельцу.** Каналы привязаны к `added_by` — id создателя канала
  (`creator`), а не того, кто добавил бота. При первой регистрации
  `handlers/chatMember.ts` спрашивает `getChatAdministrators` и берёт владельцем
  именно создателя (иначе любой со-админ мог бы перехватить канал; при сбое API
  канал не регистрируется). Все пользовательские запросы фильтруются по владельцу;
  смену настроек проверяет сам SQL (`setAutoApprove` меняет строку только если
  `added_by = owner` и возвращает `changes > 0`).
- **`allowed_updates` задаётся явно** в `src/telegram.ts` (`ALLOWED_UPDATES`, при
  `setWebhook`): `chat_join_request` и `my_chat_member` НЕ входят в набор по
  умолчанию — без них заявки и регистрация не приходят. Один источник правды:
  `configureTelegram` зовут и `scripts/setup.ts` (разово), и `scheduled()` в
  `index.ts` (ежедневно, для само-восстановления). При изменении набора правьте
  `telegram.ts`; на прод он доедет со следующим деплоем или ночным крон-запуском,
  но для немедленного эффекта прогоните `bun run setup`.
- **Само-восстановление обвязки Telegram.** У воркера нет «старта», поэтому вебхук
  и команды не переустанавливаются на каждый запуск (в отличие от старой
  Bun-версии). Чтобы бот не «замолчал» навсегда после `/revoke` токена или
  забытого `bun run setup`, ежедневный `scheduled()` идемпотентно вызывает
  `configureTelegram`. Восстановление занимает до суток; для немедленного —
  `bun run setup`.
- **Тихий приём.** На `chat_join_request` бот молча одобряет, если канал активен
  и авто-приём включён; иначе ничего не делает (заявка остаётся висеть). Никаких
  ответов в чат.
- **Авто-регистрация по `my_chat_member`.** Канал регистрируется (`upsertChannel`)
  только когда бот стал `administrator` с `can_invite_users === true`; владельцем
  пишется создатель канала (см. скоуп выше). Понижение/удаление/потеря права
  приглашать → `deactivateChannel` (`active = 0`, не удаление). Работаем только с
  `channel` и `supergroup`.
- **libSQL-клиент один на оба режима.** `config.db` отдаёт `{ url, authToken,
  isRemote }`: при заданном `TURSO_DATABASE_URL` — удалённая Turso, иначе
  `file:${DB_PATH}`. PRAGMA `journal_mode = WAL` и `foreign_keys = ON` ставятся
  только для локального файла (`!isRemote`) — на Turso это управляется
  платформой. Схема + миграции живут в `migrate()` в `db.ts` и НЕ выполняются при
  импорте (на Workers сетевой I/O в global scope запрещён): их зовут `scripts/migrate.ts`,
  тесты и сам воркер лениво через `ensureSchema()` — мемоизированный вызов `migrate()`
  один раз на изолят, из хендлеров `fetch`/`scheduled` (не при импорте). Так пустая
  или отставшая по схеме Turso-БД догоняется на первом же запросе, а не падает с
  «no such table». Отдельного механизма версионирования миграций нет.
- **Все функции `db.ts` асинхронные** (libSQL — async): хендлеры, `index.ts` и
  тесты обязаны их `await`-ить. Доступ к БД — `client.execute({ sql, args })` с
  именованными параметрами (`$name` в SQL, ключ `name` без префикса в `args`),
  запись+инкремент счётчика в `logJoin` — через `client.transaction("write")`.

## База

- `channels` — `chat_id` (PK), `title`, `type`, `added_by`, `auto_approve`, `active`,
  `approved_count`, `created_at`. `added_by` (создатель канала) фиксируется при
  первой регистрации и не перезаписывается (защита от перехвата владения).
  `approved_count` —
  all-time счётчик одобренных заявок, его и читает `/stats`.
- `join_events` — журнал решений (`approved`/`declined`). Уникальный индекс
  `(chat_id, user_id, requested_at)` + `INSERT OR IGNORE` делают запись
  идемпотентной (переобработка вебхука не задвоит). Журнал чистится по
  ретеншену (`pruneJoinEvents`, 90 дней, см. `src/index.ts`) — на `/stats` это
  не влияет, т.к. статистика идёт из счётчика.

## Конвенции

- Комментарии и тексты для пользователя — на русском.
- Импорты внутри `src/` — с расширением `.ts` (`allowImportingTsExtensions`,
  `verbatimModuleSyntax`); сохраняйте этот стиль.
- `strict` + `noUncheckedIndexedAccess` включены — индексный доступ к массивам
  может быть `undefined`, учитывайте это.
- Доступ к БД — только через функции из `db.ts`, не пишите SQL в хендлерах.
