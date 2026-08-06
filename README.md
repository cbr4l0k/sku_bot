# SKU Bot

SKU Bot is a self-hosted Telegram running-club event manager. The Bun server combines the API, Telegram webhook, SQLite migrations, and the built Mini App in one process; Caddy provides HTTPS and reverse-proxies public traffic to it.

## Local development

```sh
bun install
cp .env.example .env
NODE_ENV=development bun run --cwd apps/server start
```

Development mode uses Telegram long polling. Run the Mini App separately with `cd apps/miniapp && bunx vite`. Real Telegram Mini App testing requires a publicly reachable HTTPS URL; configure that URL in BotFather before testing it in Telegram.

## Deploy to a VDS

1. Create a DNS `A` record for your domain pointing to the VDS.
2. Put this repository on the VDS (clone it, or `rsync` it from a workstation).
3. Create the data directory and give it to the container's `bun` user (uid 1000):
   `mkdir -p data && chown -R 1000:1000 data`. The container runs unprivileged, so a
   root-owned bind mount makes SQLite fail with `SQLITE_CANTOPEN`.
4. Copy `.env.example` to `.env` and fill in every value, including `DOMAIN` without `https://`.
5. Start the stack: `docker compose up -d --build`.
6. Follow startup logs with `docker compose logs -f app caddy`.

Caddy obtains and renews HTTPS certificates automatically once DNS points to the server and ports 80 and 443 are reachable. The app is intentionally exposed only to the Compose network; Caddy is the public entry point.

## BotFather checklist

1. Create the bot with `/newbot`.
2. Create its Mini App with `/newapp`, short name `app`, and URL `https://<domain>/`.
3. Set the bot's menu button to open the Mini App.
4. Configure `/setcommands` for both Russian and English command scopes.

## Backups

SQLite data lives in `./data/sku.db` on the host, owned by uid 1000. Copy that file regularly while the service is stopped, or use SQLite's backup mechanism for a live backup.

## Environment

| Variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | Token issued by BotFather. |
| `DOMAIN` | Public domain name, without a protocol. |
| `ADMIN_IDS` | Comma-separated Telegram user IDs for bootstrap administrators. |
| `WEBHOOK_SECRET` | Random value used to verify Telegram webhook requests. |
| `CHECKIN_SECRET` | Random value used to sign check-in QR tokens. |
| `DATABASE_PATH` | SQLite database path; Compose sets `/app/data/sku.db`. |
| `NODE_ENV` | `development` uses polling; `production` configures the webhook. |
