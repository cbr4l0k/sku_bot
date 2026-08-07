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
3. Copy `.env.example` to `.env` and fill in every value, including `DOMAIN` without `https://`.
4. Start the stack: `docker compose up -d --build`.
5. Follow startup logs with `docker compose logs -f app caddy`.

The database lives in the `sku_data` Docker volume, not in the checkout. Nothing on the host needs to be created or `chown`ed first.

Caddy obtains and renews HTTPS certificates automatically once DNS points to the server and ports 80 and 443 are reachable. The app is intentionally exposed only to the Compose network; Caddy is the public entry point.

### Upgrading

1. Update the code on the VDS (`git pull`, or `rsync` it again).
2. Rebuild and restart: `docker compose up -d --build`.

Docker owns the `sku_data` volume, so it is independent of the checkout's path and contents. Rebuilds, `docker compose down`, re-cloning into a new directory, and `rsync --delete` all leave the database untouched.

**`docker compose down -v` deletes the database.** The `-v` flag removes named volumes, `sku_data` among them. Use plain `docker compose down`.

### Migrating an existing `./data` bind mount

Earlier deployments kept the database in `./data/sku.db` beside the checkout. Copy it into the volume once, before the new code first starts — otherwise the app boots on an empty volume and creates a fresh database.

1. On the VDS, in the repository directory, stop the stack: `docker compose down`.
2. Confirm the old file is there: `ls -l data/sku.db`.
3. Update the code (`git pull`, or `rsync` it again).
4. Copy the old directory into the new volume:
   ```sh
   docker compose run --rm --no-deps --user root \
     -v "$PWD/data:/backup:ro" app \
     sh -c 'cp -a /backup/. /app/data/ && chown -R 1000:1000 /app/data'
   ```
5. Start the stack: `docker compose up -d --build`.
6. Check the bot still knows its users and events, then keep `./data` around as an offline backup until you are satisfied.

## BotFather checklist

1. Create the bot with `/newbot`.
2. Create its Mini App with `/newapp`, short name `app`, and URL `https://<domain>/`.
3. Set the bot's menu button to open the Mini App.
4. Configure `/setcommands` for both Russian and English command scopes.

## Backups

SQLite data lives in the `sku_data` Docker volume, not on the host filesystem. Take a backup without stopping the bot:

```sh
docker compose exec -T app bun run scripts/backup.ts > sku-$(date +%F).db
```

The script runs SQLite's `VACUUM INTO` over a read-only connection, so the snapshot folds in any write-ahead log and can never be torn — copying `sku.db` alone can miss writes still living in a `sku.db-wal` sidecar. `-T` is required; without it the TTY corrupts the binary stream.

Restore a snapshot over the live database:

```sh
docker compose stop app
docker compose run --rm --no-deps -T app \
  sh -c 'rm -f /app/data/sku.db-wal /app/data/sku.db-shm && cat > /app/data/sku.db' < sku-2026-08-07.db
docker compose start app
```

Stale `-wal` and `-shm` sidecars must go with the old database; leaving them behind corrupts the restored one.

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
