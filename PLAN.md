# SKU Bot — Running Club Event Manager (Telegram Bot + Mini App)

## Context

A running club self-organizes its regular runs (no registration), but its extra activities
(races, trainings, socials) need registration with optional capacity limits, waitlists,
and on-site check-in. This project is a Telegram bot + Mini App (TMA) self-hosted on a VDS:
the bot handles onboarding (contact share) and notifications; everything else lives in the
Mini App.

**Locked decisions:** Bun · gramio · Elysia · React + Vite + Tailwind · SQLite + Drizzle ·
Docker Compose + Caddy (user has a domain) · webhook mode in prod, polling in dev ·
i18n: **Russian primary, English secondary** · admin bootstrap via `ADMIN_IDS` env var.

**Roles:** `admin` (global, from env + DB promotions), `organizer` (per-event assignment,
not a global role), `participant` (everyone else).

---

## 1. Repo layout — Bun workspaces monorepo

```
sku_bot/
├─ package.json               # workspaces: apps/*, packages/*
├─ apps/
│  ├─ server/                 # ONE Bun process: Elysia API + gramio bot + sweeper + static miniapp
│  │  └─ src/
│  │     ├─ index.ts          # boot: db migrate → bot (webhook/polling) → Elysia → sweeper
│  │     ├─ env.ts            # typed env parsing (zod), fail-fast
│  │     ├─ bot/              # gramio: start.ts, contact.ts, offers.ts, i18n/ (ru.ts, en.ts)
│  │     ├─ api/              # Elysia: auth.ts (init-data guard), me.ts, events.ts,
│  │     │                    #         organizer.ts, admin.ts
│  │     ├─ core/             # domain logic (framework-free, unit-testable):
│  │     │                    #   registration.ts, waitlist.ts, checkin.ts, stats.ts, links.ts
│  │     └─ sweeper.ts        # offer-expiry loop
│  └─ miniapp/                # React + Vite + Tailwind
│     └─ src/ (screens, components, api client via Eden Treaty, i18n, telegram.ts)
└─ packages/
   └─ db/                     # Drizzle schema, client, migrations
```

- **Single server process** serves `/api/*`, `/webhook` (gramio webhook handler), and the
  built miniapp as static files. Simplest possible VDS footprint.
- **End-to-end types via Eden Treaty**: miniapp imports `type App` from `apps/server`
  (type-only, no runtime coupling). No hand-written API contract.
- **`core/` is pure functions over the db client** — the bot handlers, API routes, and
  sweeper all call the same `core` functions (join/cancel/accept are reachable from both
  the miniapp and inline buttons, so the logic must live in one place).

## 2. DB schema (packages/db, Drizzle + `bun:sqlite`)

```
users            id (tg id, int pk) · firstName · lastName? · username? · phone?
                 locale ('ru'|'en', default 'ru') · isAdmin (bool) · isBanned (bool)
                 createdAt
events           id (pk autoinc) · title · description · startsAt (unixepoch)
                 location · capacity (int | null = unlimited)
                 status ('draft'|'published'|'closed'|'canceled')
                 createdBy → users · createdAt · updatedAt
event_organizers (eventId, userId) composite pk
registrations    id · eventId → events · userId → users
                 status ('registered'|'waitlisted'|'canceled'|'checked_in')
                 createdAt · updatedAt · checkedInAt?
                 UNIQUE(eventId, userId)
waitlist_offers  id · eventId · userId · offeredAt · expiresAt
                 status ('pending'|'accepted'|'superseded')
                 cascaded (bool, default false)   -- sweeper already issued the next offer
                 messageId? (tg message with the Accept button, for later edit)
```

Indexes: `registrations(eventId, status)`, `registrations(userId)`,
`waitlist_offers(eventId, status, expiresAt)`, `events(status, startsAt)`.

- Waitlist **position** is derived: `ORDER BY createdAt` among `status='waitlisted'` rows —
  no position column to keep consistent.
- Roles: `isAdmin` bool on users (env `ADMIN_IDS` are admins regardless of DB; miniapp
  promotions set the DB flag). Organizer = row in `event_organizers`.
- Check-in tokens are **stateless HMAC** — no table (see §4).

## 3. Waitlist engine (`core/waitlist.ts`) — DB-backed, restart-safe

Definitions (all inside one SQLite transaction — `bun:sqlite` is synchronous and
single-writer, so races serialize for free):

- `confirmed(eventId)` = count of registrations with status in (`registered`,`checked_in`)
- `reserved(eventId)` = count of `pending` offers with `expiresAt > now`
  (an offer **reserves a spot only while un-expired**; after expiry it stays claimable
  but stops reserving — that's exactly the "first come, first served" rule)
- `free(eventId)` = `capacity − confirmed − reserved` (∞ if capacity is null)

Flows:

- **join(event, user)** — reject if banned / not published / already active.
  If `free > 0` → `registered`. Else → `waitlisted` (or instant-register when capacity null).
- **cancel(event, user)** — if a `registered` spot frees → `issueOffers(event)`.
  If canceling user was waitlisted or held offers → mark their pending offers `superseded`.
- **issueOffers(event)** — while `free > 0`: pop head of waitlist (earliest `waitlisted`
  without a pending offer) → create offer (`expiresAt = now + 20min`) → send Telegram
  message (Accept inline button + "Open in app"). Store `messageId`.
- **sweeper (every 30 s)** — for each `pending` offer with `expiresAt ≤ now AND NOT cascaded`:
  set `cascaded = true`, then `issueOffers(event)` (expired offer now counts as free →
  next person gets invited **while the old offer stays claimable**).
- **accept(offerId, user)** — transactional:
  1. offer must be `pending` (expired-but-pending is fine — that's the FCFS window);
  2. if `confirmed < capacity` → registration → `registered`, offer → `accepted`;
     then if event became full → all other `pending` offers → `superseded`
     (+ notify those users, edit their offer messages to remove the button);
  3. else → offer → `superseded`, tell the user the spot was taken.
- **capacity increase / decrease** (organizer edit) — increase → `issueOffers(event)`;
  decrease never kicks anyone out (over-capacity just means no new offers).
- **event canceled** — notify all `registered` + `waitlisted`; all pending offers → `superseded`.

No `setTimeout` is ever the source of truth — everything derives from `expiresAt` in the DB,
so restarts/redeploys lose nothing.

## 4. QR check-in — stateless rotating token

Token format: `skuchk.<eventId>.<slot>.<sig>` where `slot = floor(now / 45s)` and
`sig = base64url(HMAC-SHA256(CHECKIN_SECRET, eventId + ":" + slot))[:16]`.

- **Organizer side**: attendance screen fetches `GET /api/organizer/events/:id/checkin-token`
  every ~30 s, renders it as a QR client-side (`qrcode` npm package — no external services;
  the miniapp CSP/self-hosting stays clean).
- **Participant side**: "Scan" button → `Telegram.WebApp.showScanQrPopup` →
  `POST /api/checkin { code }` → server recomputes HMAC for current **and previous** slot
  (90 s grace), checks the user is `registered` for that event → `checked_in`.
- **Manual fallback**: organizer's attendance list has a per-person check-in toggle.
- No DB table, no token cleanup, nothing to rotate on restart.

## 5. Deep links

- **Registration link (admins generate, shareable anywhere):**
  `https://t.me/<bot>/<appname>?startapp=evt_<id>` — payload arrives in the miniapp as
  `initDataUnsafe.start_param` (NOT `/start`!), router opens the event page.
- **Bot fallback:** `https://t.me/<bot>?start=evt_<id>` → `/start` handler (payload in
  `ctx.args`) sends the event card with a URL button to the `startapp` link above.
- Payloads: `evt_<int>` — well inside the 64-char base64url alphabet; treated as untrusted
  (server always re-checks the event is published/visible).

## 6. Bot chat surface (minimal, button-first, ru/en via @gramio/i18n)

- **/start** — new user → reply keyboard with `requestContact` ("Поделиться контактом 📱");
  on `contact` message (must be the user's own — check `contact.userId === ctx.from.id`)
  → upsert user with phone, remove keyboard, show hero: bold title + short blockquote +
  inline keyboard [🏃 Открыть приложение (web_app) · 📅 Ближайшие события].
  With `evt_` payload → registration is still required first, then the event card.
- **Waitlist offer message** — "Место освободилось!" + event summary + deadline;
  inline keyboard: [✅ Принять (CallbackData `offer{id}`)] [📱 Открыть в приложении].
  Accept handler calls `core.accept` and edits the message with the outcome; `ctx.answer()`
  first, always. Never `parse_mode` — `format` entities only.
- **Notifications**: offer superseded ("место занято"), event canceled/edited, confirmed spot.
- Locale: from `users.locale` (initialized from `language_code`, override in profile).

## 7. API (Elysia, all under `/api`, auth via `x-init-data` header)

Guard (from gramio's TMA pattern): `validateAndParseInitData(header, secretKey)` →
upsert-load user → derive `{ user }`. Banned users: read-only (mutating participant routes
403). Role guards: `requireAdmin` (env or DB), `requireOrganizer(eventId)` (admin OR row in
`event_organizers`).

```
GET   /api/me                         PATCH /api/me            { locale, firstName… }
GET   /api/events                     # published, incl. my registration/offer state
GET   /api/events/:id
POST  /api/events/:id/join            POST  /api/events/:id/cancel
POST  /api/offers/:id/accept          POST  /api/checkin       { code }

GET   /api/organizer/events           # events I organize
PATCH /api/organizer/events/:id       # time/location/capacity/description edits
GET   /api/organizer/events/:id/attendance
GET   /api/organizer/events/:id/checkin-token
POST  /api/organizer/events/:id/attendance/:userId   # manual check-in toggle

POST  /api/admin/events               PATCH/DELETE /api/admin/events/:id
PUT   /api/admin/events/:id/organizers   { userIds }
GET   /api/admin/events/:id/stats     GET /api/admin/events/:id/link
GET   /api/admin/users?query=         POST /api/admin/users/:id/ban|unban|promote|demote
GET   /api/admin/stats
```

## 8. Miniapp (React + Vite + Tailwind + Eden Treaty client)

- Telegram integration: **plain `window.Telegram.WebApp`** behind one typed wrapper module
  (`src/telegram.ts`, types from `@twa-dev/types`) — lighter than the SDK packages and we
  only need theme, initData, start_param, scanner, back button, haptics.
- Theme: Tailwind mapped to Telegram CSS variables (`var(--tg-theme-bg-color)` etc.) so it
  follows the user's Telegram theme automatically; distinctive typography/accents per the
  frontend-design pass (this is the taste-critical surface).
- Routing: react-router (memory history), entry resolves `start_param` → `/events/:id`.
- Screens:
  - **Participant**: Events list (upcoming, with my-status badges) · Event detail
    (join / cancel / waitlist position / offer banner with countdown / accept) ·
    My registrations · Profile (name, phone, language) · Scan-to-check-in.
  - **Organizer** (tab appears if I organize ≥1 event): My events · Attendance dashboard
    (live list, search, manual toggle, big rotating QR view) · Event edit form.
  - **Admin** (tab if admin): Events CRUD (+ draft/publish, copy registration link) ·
    Per-event stats · Users (search, ban, promote, assign organizers) · Global stats.
- i18n: tiny typed dictionary module (`ru.ts` / `en.ts`, `t('key')` with union-typed keys),
  locale from `/api/me`.

## 9. Statistics (admin)

- **Per event**: registered / waitlisted / checked-in counts, check-in (attendance) rate,
  no-show rate, waitlist conversion (offers accepted / offers made).
- **Global**: events per month, unique participants, avg fill rate (confirmed/capacity),
  overall attendance rate trend, top-N most active participants.
- All are simple `GROUP BY` over `registrations`/`waitlist_offers` — computed live, no
  aggregation tables at this scale.

## 10. Deployment (VDS)

```
docker-compose.yml:
  app:    Bun image, builds miniapp → serves API+webhook+static on :3000
          volumes: ./data:/app/data   (SQLite: /app/data/sku.db)
  caddy:  ports 80/443, Caddyfile: {$DOMAIN} → reverse_proxy app:3000
          volumes for caddy_data (Let's Encrypt certs)
```

- `.env`: `BOT_TOKEN`, `DOMAIN`, `ADMIN_IDS`, `WEBHOOK_SECRET` (Telegram secret_token),
  `CHECKIN_SECRET`, `NODE_ENV`.
- Boot: run Drizzle migrations → `bot.start({ webhook })` in prod (sets
  `https://$DOMAIN/webhook`, verifies `X-Telegram-Bot-Api-Secret-Token`), long-polling in
  dev. Graceful shutdown on SIGINT/SIGTERM.
- **BotFather checklist**: create bot → `/newapp` (Mini App, short name = `app`, URL
  `https://$DOMAIN/`) → menu button → `/setcommands` (ru + en scopes).

## 11. Execution plan — work packages & agent assignment

Orchestration: **fable (this session) coordinates + reviews**; mechanical implementation →
**Codex/gpt-5.6** (codex-implementation skill, worktree isolation when parallel); the
miniapp UI (taste-critical) → **opus/fable-tier agent** with the frontend-design +
dataviz skills. Every bot-touching agent gets the gramio reference files inline
(callback-data, formatting, middleware-routing, deep-links, tma, webhook, ux-patterns).

| WP | Scope | Depends | Agent |
|----|-------|---------|-------|
| 1 | Monorepo scaffold, workspaces, tsconfigs, `packages/db` schema + migrations, `env.ts` | — | codex |
| 2 | `core/`: registration + **waitlist engine** + checkin + links + unit tests (bun:test, in-memory sqlite) | 1 | codex (spec above), **fable reviews closely** |
| 3 | Server shell: Elysia + init-data auth guard + gramio bot wiring (webhook/polling) + i18n + sweeper | 1 | codex |
| 4 | Bot surface: /start + deep links, contact registration, offer messages + Accept callback, notifications | 2,3 | codex + gramio refs |
| 5 | API routes (me/events/organizer/admin) + role guards + stats queries | 2,3 | codex |
| 6 | Miniapp: all screens, Telegram theme, Eden client, i18n, QR render+scan | 5 | **opus** (frontend-design skill) |
| 7 | Docker Compose + Caddy + deploy README + BotFather checklist | 3 | codex |
| 8 | End-to-end review: fable code review + `codex review` second opinion; typecheck + tests green | all | fable + codex |

WP 4/5 can run in parallel (worktrees); WP 6 and 7 in parallel after 5/3.

**Verification**: `bun run typecheck` + `bun test` (core waitlist scenarios: cancel→offer,
expiry cascade, FCFS double-accept race, supersede-on-fill, capacity increase); manual
run in dev with polling + signed test init-data (`signInitData`) against the API;
final smoke on the VDS after `docker compose up`.
