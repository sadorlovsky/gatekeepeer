# gatekeepeer

Telegram-бот, который автоматически принимает заявки на вступление в приватные
каналы и чаты. Мультиарендный: добавьте его админом в свой канал — владельцем
настроек станет создатель канала. Личный чат с ботом — пульт управления, где
каждый видит только свои каналы.

Стек: **Bun · TypeScript · [grammY](https://grammy.dev) · libSQL
([Turso](https://turso.tech))**, апдейты через webhook.

## Что делает

- Молча одобряет `chat_join_request`, если канал подключён и авто-приём включён.
- Сам регистрирует канал, когда его добавили админом с правом приглашать.
- В личке: `/channels`, `/status`, `/stats`, `/help`; авто-приём — кнопками.

## Запуск

```sh
bun install
cp .env.example .env   # заполнить BOT_TOKEN, WEBHOOK_URL, WEBHOOK_SECRET
```

Вебхуку нужен публичный HTTPS — локально через туннель:

```sh
cloudflared tunnel --url http://localhost:3000   # адрес → WEBHOOK_URL
bun run dev
```

В разработке БД — локальный SQLite-файл; для прода задайте `TURSO_DATABASE_URL` и
`TURSO_AUTH_TOKEN`. При старте бот сам вызывает `setWebhook` с нужными
`allowed_updates`.

## Подключение канала

1. Включите в канале приём по заявкам (invite-ссылка с «Approve new members»).
2. Добавьте бота админом с правом **«Добавлять участников»**.
3. Управляйте через `/channels` в личке с ботом.

## Деплой (Fly.io + Turso)

```sh
turso db create gatekeepeer
turso db show --url gatekeepeer        # → TURSO_DATABASE_URL
turso db tokens create gatekeepeer     # → TURSO_AUTH_TOKEN

fly launch --no-deploy --copy-config --name <app> --region fra
fly secrets set BOT_TOKEN=… WEBHOOK_SECRET=… \
  WEBHOOK_URL="https://<app>.fly.dev" \
  TURSO_DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…"
fly deploy
```

Проверка: `fly logs` и `GET https://<app>.fly.dev/health` → `ok`.

## Команды

```sh
bun run dev      # запуск с автоперезапуском
bun start        # обычный запуск
bun test         # тесты
bunx tsc --noEmit  # проверка типов
```
