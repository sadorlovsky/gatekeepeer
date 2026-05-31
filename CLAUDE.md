# CLAUDE.md

Telegram-бот авто-приёма заявок на вступление в приватные каналы/чаты.
Мультиарендный: любой добавляет бота админом в свой канал и становится
владельцем его настроек. Личка с ботом — пульт управления, каждый видит только
свои каналы.

## Стек и запуск

- **Bun + TypeScript + [grammY](https://grammy.dev) + libSQL ([@libsql/client](https://docs.turso.tech))**, апдейты через **webhook** (не long-polling). БД — Turso в проде, локальный файл SQLite (`file:…`) в разработке; клиент один и тот же, выбор делает `config.db`.
- `bun run dev` — запуск с автоперезапуском (`bun --watch`).
- `bun start` — обычный запуск.
- `bunx tsc --noEmit` — проверка типов (есть `noEmit`, эмита нет — только typecheck).
- `bun test` — тесты (`test/app.test.ts`): интеграционно проверяют поток через
  хендлеры и БД на временной SQLite (миграции, скоуп по владельцу, идемпотентность
  журнала, команды/колбэки, регистрация на creator). `bun test --coverage` —
  покрытие. Линтера в проекте нет.

Вебхуку нужен публичный HTTPS — локально поднимается туннель (`cloudflared`/`ngrok`)
на порт 3000, его адрес кладётся в `WEBHOOK_URL`. При старте бот сам зовёт
`setWebhook` с явным `allowed_updates`.

## Конфигурация (`.env`, читается Bun автоматически)

- `BOT_TOKEN` — токен от BotFather (обязателен).
- `WEBHOOK_URL` — публичный https-адрес (обязателен).
- `WEBHOOK_SECRET` — секрет для проверки апдейтов (обязателен).
- `PORT` — порт HTTP-сервера, по умолчанию `3000`.
- `TURSO_DATABASE_URL` — адрес Turso-БД (`libsql://…`). Если задан — работаем с
  Turso; иначе откатываемся на локальный файл из `DB_PATH`.
- `TURSO_AUTH_TOKEN` — токен Turso. Обязателен, когда `TURSO_DATABASE_URL` —
  сетевой адрес (`libsql`/`https`/`wss`); для `file:` не нужен.
- `DB_PATH` — путь к локальному SQLite-файлу для разработки, по умолчанию
  `gatekeepeer.sqlite`. Используется только когда `TURSO_DATABASE_URL` пуст.
- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` — LLM-модерация спама (опционально,
  OpenAI-compatible). Без `LLM_API_KEY` модуль модерации не подключается
  (`config.moderationEnabled = false`). `LLM_BASE_URL` по умолчанию
  `https://api.openai.com/v1`, `LLM_MODEL` — `gpt-4o-mini`. Сменив `LLM_BASE_URL`,
  можно ходить в OpenRouter или локальную модель тем же кодом.

Валидация в `src/config.ts`: отсутствие обязательной переменной кидает ошибку на старте.

## Архитектура

```
src/
  config.ts            конфиг из .env с валидацией
  db.ts                bun:sqlite: схема + типизированные функции доступа
  bot.ts               сборка Bot и регистрация всех хендлеров
  keyboards.ts         inline-клавиатуры (список ↔ экран канала, капча)
  handlers/
    joinRequest.ts     chat_join_request — приём по режиму (approve/decline/captcha)
    chatMember.ts      my_chat_member — авто-регистрация/деактивация канала
    commands.ts        /start /help /channels /status /stats
    callbacks.ts       inline-кнопки: навигация, тогглы, режим, капча
    moderation.ts      message/channel_post — LLM-модерация спама (опц.)
  moderation/
    heuristics.ts      дешёвый пре-фильтр перед вызовом LLM
    classify.ts        OpenAI-compatible классификация спама
  index.ts             Bun.serve + webhook + setWebhook на старте
```

Поток данных: `index.ts` (HTTP/webhook) → `bot.ts` (роутинг grammY) → хендлеры → `db.ts`.

## Ключевые инварианты

- **Скоуп по владельцу.** Каналы привязаны к `added_by` — id создателя канала
  (`creator`), а не того, кто добавил бота. При первой регистрации
  `handlers/chatMember.ts` спрашивает `getChatAdministrators` и берёт владельцем
  именно создателя (иначе любой со-админ мог бы перехватить канал; при сбое API
  канал не регистрируется). Все пользовательские запросы фильтруются по владельцу;
  смену настроек проверяет сам SQL (`setAutoApprove` меняет строку только если
  `added_by = owner` и возвращает `changes > 0`).
- **`allowed_updates` задаётся явно** в `src/index.ts`: `chat_join_request`,
  `my_chat_member` и `channel_post` НЕ входят в набор по умолчанию — без них заявки,
  регистрация и модерация постов не приходят. При изменении набора апдейтов правьте здесь.
- **Приём по режиму (`join_mode`).** `auto_approve` — мастер-выключатель: при `0`
  заявка просто висит (бот ничего не делает). При `1` действие выбирает `join_mode`:
  `approve` — молча одобрить (дефолт, как раньше), `decline` — молча отклонить,
  `captcha` — написать заявителю в личку и ждать подтверждения. Никаких ответов в
  сам чат. Режим переключается с экрана канала в личке.
- **Капча.** На `chat_join_request` с режимом `captcha` бот пишет заявителю через
  `chat_join_request.user_chat_id` (личка доступна боту 5 минут после подачи, даже
  без `/start` заявителем) и заводит строку в `captcha_pending`. Заявку одобряет
  только колбэк `cap:` после нажатия кнопки — он НЕ скоупится по владельцу (нажимает
  сам заявитель). `getCaptchaPending == null` → идемпотентный выход. Истёкшие
  записи чистит таймер в `src/index.ts` (`prunePendingCaptcha`, 30 мин); их заявки
  остаются висеть.
- **LLM-модерация (опц., opt-in).** Подключается в `bot.ts` только при
  `config.moderationEnabled` (задан `LLM_API_KEY`). Per-channel флаг
  `moderation_enabled` (по умолчанию `0`). Поток: `message`/`channel_post` →
  `getChannel` (гейт `active && moderation_enabled`) → `shouldClassify` (дешёвый
  пре-фильтр) → `classifySpam` (OpenAI-compatible, fail-open) → при спаме
  `deleteMessage` (MVP — без бана). Классификатор инжектируется в
  `registerModeration` (в тестах — стаб, без сети). **Privacy mode:** в группах бот
  читает сообщения только при выключенном privacy mode в BotFather ИЛИ будучи
  админом (наш бот — админ, покрыто); для каналов нужен `channel_post` и админ-статус.
- **Авто-регистрация по `my_chat_member`.** Канал регистрируется (`upsertChannel`)
  только когда бот стал `administrator` с `can_invite_users === true`; владельцем
  пишется создатель канала (см. скоуп выше). Понижение/удаление/потеря права
  приглашать → `deactivateChannel` (`active = 0`, не удаление). Работаем только с
  `channel` и `supergroup`.
- **libSQL-клиент один на оба режима.** `config.db` отдаёт `{ url, authToken,
  isRemote }`: при заданном `TURSO_DATABASE_URL` — удалённая Turso, иначе
  `file:${DB_PATH}`. PRAGMA `journal_mode = WAL` и `foreign_keys = ON` ставятся
  только для локального файла (`!isRemote`) — на Turso это управляется
  платформой. Схема + миграции прогоняются на **top-level await** в `db.ts` при
  импорте; миграций как отдельного механизма нет.
- **Все функции `db.ts` асинхронные** (libSQL — async): хендлеры, `index.ts` и
  тесты обязаны их `await`-ить. Доступ к БД — `client.execute({ sql, args })` с
  именованными параметрами (`$name` в SQL, ключ `name` без префикса в `args`),
  запись+инкремент счётчика в `logJoin` — через `client.transaction("write")`.

## База

- `channels` — `chat_id` (PK), `title`, `type`, `added_by`, `auto_approve`, `active`,
  `approved_count`, `join_mode`, `welcome_pending`, `moderation_enabled`,
  `created_at`. `added_by` (создатель канала) фиксируется при первой регистрации и
  не перезаписывается (защита от перехвата владения). `approved_count` — all-time
  счётчик одобренных заявок, его и читает `/stats`. `join_mode` (`approve`/`decline`/
  `captcha`, дефолт `approve`) — действие при включённом приёме. `welcome_pending` —
  флаг недоставленного приветствия (DM упал, владелец не нажал `/start`); доставка
  на `/start` (`listPendingWelcome`/`markWelcomePending`). `moderation_enabled` —
  per-channel LLM-модерация.
- `join_events` — журнал решений (`approved`/`declined`). Уникальный индекс
  `(chat_id, user_id, requested_at)` + `INSERT OR IGNORE` делают запись
  идемпотентной (переобработка вебхука не задвоит). Журнал чистится по
  ретеншену (`pruneJoinEvents`, 90 дней, см. `src/index.ts`) — на `/stats` это
  не влияет, т.к. статистика идёт из счётчика.
- `captcha_pending` — состояние окна капчи: PK `(chat_id, user_id)`,
  `user_chat_id` (для DM), `requested_at` (для идемпотентного `logJoin` при
  одобрении), `prompt_msg_id`. `INSERT OR IGNORE` → ретрай вебхука не задвоит.

## Конвенции

- Комментарии и тексты для пользователя — на русском.
- Импорты внутри `src/` — с расширением `.ts` (`allowImportingTsExtensions`,
  `verbatimModuleSyntax`); сохраняйте этот стиль.
- `strict` + `noUncheckedIndexedAccess` включены — индексный доступ к массивам
  может быть `undefined`, учитывайте это.
- Доступ к БД — только через функции из `db.ts`, не пишите SQL в хендлерах.
