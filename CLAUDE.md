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
- `CAS_ENABLED` / `CAS_API_URL` / `CAS_TIMEOUT_MS` — внешний blocklist Combot
  Anti-Spam (отсев известных спамеров по user_id до LLM). Включён по умолчанию
  (`CAS_ENABLED=false` отключает); `CAS_API_URL` по умолчанию
  `https://api.cas.chat/check`, таймаут `3000` мс. Работает только при включённой
  LLM-модерации (модуль модерации подключается лишь при `LLM_API_KEY`).
- `MODERATION_FIRST_MESSAGES` — сколько первых «чистых» сообщений новичка проверять,
  прежде чем считать его доверенным и пропускать модерацию (по умолчанию `3`).

Валидация в `src/config.ts`: отсутствие обязательной переменной кидает ошибку на
старте. Опциональные числовые переменные (`CAS_TIMEOUT_MS`, `MODERATION_FIRST_MESSAGES`)
при некорректном значении логируют предупреждение и откатываются на дефолт, не валя бот.

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
    heuristics.ts      пре-фильтр перед LLM: ссылки/метаданные → эскалация
    classify.ts        OpenAI-compatible классификация спама
    cas.ts             проверка user_id по внешнему blocklist CAS (кэш + fail-open)
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
  `moderation_enabled` (по умолчанию `0`). Многослойный конвейер перед дорогим LLM
  (`handlers/moderation.ts`): `getChannel` (гейт `active && moderation_enabled &&
  can_delete`) → **доверие новичка** (`getSeenCount >= MODERATION_FIRST_MESSAGES` →
  пропуск) → **CAS** (`checkCas` по `user_id`, попадание → `deleteMessage`) →
  `shouldClassify` (расширенный пре-фильтр: ссылки/упоминания + метаданные —
  эмодзи-флуд, смешение алфавитов, abnormal spacing, форвард, кнопки, медиа без
  подписи) → `classifySpam` (OpenAI-compatible, fail-open) → при спаме
  `deleteMessage` (MVP — без бана). Удаляют только два жёстких сигнала: CAS и LLM;
  эвристики лишь эскалируют к LLM. `classify` и `checkCas` инжектируются в
  `registerModeration(bot, { classify, checkCas })` (в тестах — стабы, без сети;
  CAS обязательно стабить, иначе тест пойдёт в `api.cas.chat`).
  **Инвариант доверия:** `bumpSeen` (инкремент `moderation_seen.msg_count`)
  вызывается ТОЛЬКО для чистых сообщений (`shouldClassify=false` или LLM=ham),
  НИКОГДА при CAS-hit/LLM-spam — иначе спамер за N сообщений станет доверенным.
  Фичи доверия и CAS применяются только к `message` (есть `from`); `channel_post`
  (нет автора) идёт укороченным путём `gate → shouldClassify → classify → delete`.
  Команды бота (`bot_command` со `offset=0`) не модерируются. **Privacy mode:** в
  группах бот читает сообщения только при выключенном privacy mode в BotFather ИЛИ
  будучи админом (наш бот — админ, покрыто); для каналов нужен `channel_post` и
  админ-статус.
- **Авто-регистрация по `my_chat_member`.** Канал регистрируется (`upsertChannel`),
  когда бот стал `administrator` с правом приглашать (`can_invite_users`) **ИЛИ**
  удалять (`can_delete_messages`) — права независимы и используются порознь. Эти два
  права пишутся в `channels.can_invite` / `can_delete` и обновляются при каждом
  событии (в т.ч. при реактивации). Владельцем пишется создатель канала (см. скоуп
  выше). Потеря **обоих** прав / понижение / удаление → `deactivateChannel`
  (`active = 0`, не удаление). Работаем только с `channel` и `supergroup`.
- **Способности гейтятся по правам.** Приём заявок (`handlers/joinRequest.ts`)
  требует `can_invite === 1`; LLM-модерация (`handlers/moderation.ts`) — `can_delete
  === 1`. Так бот, добавленный админом без права приглашать, работает как чистый
  антиспам. Экран канала и клавиатура (`keyboards.ts`) показывают только доступные по
  правам блоки; колбэки в `callbacks.ts` дополнительно проверяют право (защита от
  устаревшей кнопки).
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
  `can_invite`, `can_delete`, `created_at`. `added_by` (создатель канала) фиксируется
  при первой регистрации и не перезаписывается (защита от перехвата владения).
  `approved_count` — all-time счётчик одобренных заявок, его и читает `/stats`.
  `join_mode` (`approve`/`decline`/`captcha`, дефолт `approve`) — действие при
  включённом приёме. `welcome_pending` — флаг недоставленного приветствия (DM упал,
  владелец не нажал `/start`); доставка на `/start` (`listPendingWelcome`/
  `markWelcomePending`). `moderation_enabled` — per-channel LLM-модерация.
  `can_invite` / `can_delete` — текущие права бота в чате, обновляются на каждом
  `my_chat_member`; гейтят приём заявок и модерацию соответственно. Дефолт миграции
  на legacy-БД — `1` для обоих (каналы регистрировались при праве приглашать;
  `can_delete` оптимистичен, перепроверяется при следующем событии).
- `join_events` — журнал решений (`approved`/`declined`). Уникальный индекс
  `(chat_id, user_id, requested_at)` + `INSERT OR IGNORE` делают запись
  идемпотентной (переобработка вебхука не задвоит). Журнал чистится по
  ретеншену (`pruneJoinEvents`, 90 дней, см. `src/index.ts`) — на `/stats` это
  не влияет, т.к. статистика идёт из счётчика.
- `captcha_pending` — состояние окна капчи: PK `(chat_id, user_id)`,
  `user_chat_id` (для DM), `requested_at` (для идемпотентного `logJoin` при
  одобрении), `prompt_msg_id`. `INSERT OR IGNORE` → ретрай вебхука не задвоит.
- `moderation_seen` — трекинг доверия новичков для модерации: PK `(chat_id,
  user_id)`, `msg_count` (число чистых сообщений автора), `last_seen`. `bumpSeen`
  (UPSERT `+1`) зовётся только для чистых сообщений; при `msg_count >=
  MODERATION_FIRST_MESSAGES` модерация пропускается. Чистится по ретеншену
  (`pruneModerationSeen`, 30 дней по `last_seen`, см. `src/index.ts`).

## Конвенции

- Комментарии и тексты для пользователя — на русском.
- Импорты внутри `src/` — с расширением `.ts` (`allowImportingTsExtensions`,
  `verbatimModuleSyntax`); сохраняйте этот стиль.
- `strict` + `noUncheckedIndexedAccess` включены — индексный доступ к массивам
  может быть `undefined`, учитывайте это.
- Доступ к БД — только через функции из `db.ts`, не пишите SQL в хендлерах.
