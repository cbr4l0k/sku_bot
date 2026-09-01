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
| `EVENT_GROUPS` | **Deprecated.** The chat catalog lives in the database now (see [Chats and cities](#chats-and-cities)). Anything still listed is filed under Saint Petersburg at boot and the variable can then be deleted. |
| `WEBHOOK_SECRET` | Random value used to verify Telegram webhook requests. |
| `CHECKIN_SECRET` | Random value used to sign check-in QR tokens. |
| `YOOKASSA_SHOP_ID` | ЮKassa shop id. Leave empty together with `YOOKASSA_SECRET_KEY` to keep paid checkout disabled. |
| `YOOKASSA_SECRET_KEY` | ЮKassa secret key. It is used by the server only and must never reach the Mini App. |
| `YOOKASSA_WEBHOOK_SECRET` | High-entropy secret placed in the ЮKassa notification URL. Required when payments are configured. |
| `YOOKASSA_VAT_CODE` | Optional receipt VAT code (1–10). When set, checkout includes a receipt and requires the user's saved phone number. Confirm the value with the club's accountant. |
| `DATABASE_PATH` | SQLite database path; Compose sets `/app/data/sku.db`. |
| `NODE_ENV` | `development` uses polling; `production` configures the webhook. |

## Paid tickets with ЮKassa

Events remain free until an organizer adds at least one ticket tier. Once an event
has ticket history, its direct free-signup paths stay disabled even if every tier is
later hidden. This prevents a stale Telegram button from issuing an unpaid ticket.

The first version deliberately has one merchant: the club. It supports fixed RUB
ticket tiers, one ticket per Telegram user per event, optional merchandise and
add-ons with quantities, automatic refunds, and no payouts to organizers. A
purchase may contain one ticket plus optional products, or products alone, and is
paid as one YooKassa transaction. A merch-only purchase never grants event entry.

The Telegram event card exposes each available ticket as its own Mini App button.
The chosen ticket is preselected when the app opens; the user can still switch or
remove it, add merch or extras, review the combined total, and then pay. Events may
also have a shop without any ticket tiers. In the event view the shop is deliberately
placed directly below the title and before the description.

### State machine

The redirect back from ЮKassa is navigation only and never proves payment. The
public webhook is also treated only as a prompt: the server retrieves the object
from ЮKassa, verifies its order id, amount and currency, and only then advances the
durable order.

```text
awaiting_payment ── provider succeeded ──> payment_succeeded ──> fulfilled
       │                                          │                  │
       ├── expiry ──> cancel_pending ──> canceled │                  │
       │                                          └── event canceled ┤
       └── late success after cancellation ──────────────────────────┤
                                                                  refund_pending
                                                                    ├──> refunded
                                                                    └──> refund_failed
```

Creating checkout reserves every selected product's quantity and, only when a ticket
is present, event capacity and the tier quota in one database transaction. Names,
unit prices, kinds, and quantities are
copied into immutable order-item snapshots; the server calculates the total from
those snapshots and sends separate receipt lines (ticket/add-ons as services,
merchandise as commodities). Client totals and Telegram button data are never
trusted. An expired
reservation is released only after ЮKassa confirms cancellation. If success arrives
after local cancellation, the order is refunded rather than fulfilled. Repeated API
calls and webhook deliveries are safe: provider mutations use stable idempotency
keys and every local transition is conditional and transactional.

A paid attendee's cancellation keeps their registration and capacity reserved while
the refund is pending. It is canceled only after ЮKassa confirms the refund. If an
event is canceled, refunds start automatically; the payment sweeper resumes any
unfinished creation, cancellation, or refund work after restarts and outages.

### Enabling payments

1. Configure a ЮKassa test or production shop and put `YOOKASSA_SHOP_ID`,
   `YOOKASSA_SECRET_KEY`, and a long random `YOOKASSA_WEBHOOK_SECRET` in `.env`.
   The shop id and key must be present together; the webhook secret is mandatory
   whenever they are set.
2. In ЮKassa, point notifications to
   `https://<DOMAIN>/api/payments/yookassa/webhook?secret=<YOOKASSA_WEBHOOK_SECRET>`
   and enable payment success,
   payment cancellation, refund success, and refund cancellation events.
3. If ЮKassa is responsible for fiscal receipts, set `YOOKASSA_VAT_CODE` to the
   value approved for the club. The bot already collects a phone number and sends it
   as the receipt contact. Receipt and tax configuration remains the merchant's legal
   responsibility.
4. Create a draft event, add tiers in **Tickets**, add optional sellable SKUs in
   **Merch and extras**, and run a full
   test-shop payment, cancellation, event cancellation, duplicated webhook, and
   restart/reconciliation pass before switching to the live shop.

Without credentials the server still migrates the payment tables and organizers can
prepare ticket tiers and products, but checkout buttons are disabled and the API returns
`payments_not_configured`. No fake or accidental live payment path is enabled.

Paid events do not use the existing free waitlist in this version: a waitlist offer
would itself need a tier-specific payment reservation. Sold-out paid tiers therefore
close cleanly. Events with payment history cannot be hard-deleted; cancel them so the
financial audit trail and refunds remain intact.

## The queue

Every event carries a queue switch, toggled from the event's admin screen. It is **on** by
default, which is the existing behaviour: once an event fills up, further signups join a
waitlist, and a cancellation offers the freed spot to whoever is first in line.

During the final **2 hours before the event starts**, a freed spot is urgent: the offer is
sent to everyone still waiting instead of moving through the queue one person at a time. The
available spot (or spots) goes to whoever accepts first; acceptance remains transactional, so
the event cannot be overbooked. The offer sweeper detects the 2-hours boundary even when an
ordered offer was already outstanding and notifies the rest of the queue then.

Turn it **off** and a full event simply stops accepting people — the signup button becomes
"no spots left, and this event has no queue", and the API answers `409 event_full`. Freed
spots are not handed on. An event with no capacity limit is unaffected either way.

Switching it off does **not** discard anyone already queued: their places are kept but go
dormant, no further offers are sent, and the admin screen says how many people that affects
before the switch is confirmed. Switching it back on resumes the queue immediately, handing
out any spots that came free while it was off.

## When an event is over

Nothing about the clock ends an event. It runs — listed, joinable, and open for check-in —
until an organizer or admin presses **End event** on its screen. That is what makes the QR
usable *after* the class, which is when people actually get around to scanning it, and it
lets a walk-in sign up mid-session.

Ending an event closes check-in (the QR stops minting, and a scan answers `event_over`),
stops further signups, retires any pending queue offers, and drops the event out of the
participant list. Two things deliberately survive it: the attendance list stays editable by
hand, so the roster can be corrected afterwards, and **Reopen event** undoes an end that came
too early — check-in starts working again and the queue picks up where it left off.

Organizers see a **Running** chip on any event whose start time has passed but which nobody
has ended yet, so a forgotten one is easy to spot in the list.

## Cities

The club runs in three cities, and every event belongs to exactly one of them:

| Slug | Branch | Field | Logo |
| --- | --- | --- | --- |
| `spb` | Saint Petersburg | `#0097a8` | `#3eafbd` |
| `msk` | Moscow | `#ff1744` | `#fe3d62` |
| `kzn` | Kazan | `#03c452` | `#27cb6c` |

They are defined once, in `packages/cities/src/index.ts`, and imported by the database
package, the server and the Mini App alike. Adding a branch is that file plus a migration
for the new slug — the palette derives itself (see below).

**Choosing a city is a browsing filter, not a permission.** People pick their branch on
first open and can change it in their profile; the event list then shows that branch's runs.
A deep link to another city still resolves, still joins, and still checks in — and a run you
hold a spot at keeps showing up in **Mine** after you switch back, so nobody loses the cancel
button by moving.

Every branch keeps Moscow time today (Tatarstan does too), but the zone is per-city in the
config, so a fourth branch will not be the one to discover that assumption.

### The palette

A branch declares three colours — the field, the logo mark, and a backdrop wash — and the
other ten tokens are mixed out of the field with `color-mix(in oklab, …)` in
`apps/miniapp/src/index.css`. The mix percentages are the largest that hold every contrast
ratio in **all three** branches at once; green binds the deep rung, red binds the ink.

Kazan sets `fieldInk: "dark"`, because `#03c452` is a light colour: white on it is 2.33:1
and fails outright, where Petersburg's field gives 3.50:1 and Moscow's 3.85:1. That flips
`--ink`, `--flare` and `--ghost-bg` to near-black for that branch, and every component
follows without knowing anything about it.

The backdrop wash is a separate token from the logo colour on purpose: the logo colours of
Moscow and Kazan sit too close to their own field to read as a shape (`#27cb6c` on `#03c452`
is 1.09:1, effectively invisible), so the wash is lifted off them to match Petersburg's
1.35:1 separation.

## Roles

Three levels, from the top:

| Role | Reach |
| --- | --- |
| **General admin** | The whole club, every city. `users.is_admin`, with `ADMIN_IDS` as an unrevokable floor. Only they ban people, promote general admins, and file chats under a city. |
| **City admin** | Everything a general admin can do, bounded to one city: raising, editing, publishing, ending and cancelling its events, and appointing organizers in it. They cannot mint or unseat a peer. |
| **City organizer** | May raise a run in their city and then run the ones they are named on — nothing else in the branch. |

City roles live in `user_city_roles`, one per person per city, so the same person can run
Moscow and help out in Kazan. They sit *beneath* `users.is_admin`, which still means the
whole club.

Being named on an event (`event_organizers`) is enough to run that event on its own, with no
city role behind it — every organizer who existed before cities did keeps working untouched.
Whoever raises an event is named on it automatically.

Moving an event between cities takes authority over **both** ends, since it hands the run to
people you may not be.

## Restricted events

An event can be limited to the members of one or more Telegram groups of its own city.

**The bot must be an administrator in each of those chats.** Telegram only guarantees
`getChatMember` answers about other users to admins; without that, every lookup fails, the
group shows up unnamed in the admin UI, and the events stay closed to everyone.

### Chats and cities

The catalog is a `chats` table, not an environment variable — chats no longer need a
redeploy to change:

1. Add the bot to the group and promote it to administrator. **It files itself**, appearing
   under Admin → Chats as awaiting a city. `/chatid` still works as a fallback for a group
   the bot joined before this shipped.
2. A **general admin** picks the group's city. Until then the chat is inert: no event can
   restrict itself to it or funnel runners into it.
3. It is then offered on that city's events only — a Kazan admin never sees Moscow's groups.

Group IDs are **negative**: supergroups start with `-100`. The positive number in a
`t.me/c/<number>/…` link is not the chat ID.

Telegram silently upgrades a basic group to a supergroup when certain features are used,
and **the chat ID changes** when it does. Everything that names the chat follows the move
automatically now — the catalog row and its city, the restrictions, the event chat, and the
guest trials — so an upgrade needs no admin action at all. Note that `getChat` keeps
answering on the dead ID, so a stale group looks healthy until a membership lookup is
actually tried, which is why the UI probes the bot's own membership rather than just
fetching the title.

Admins restrict an event from the event form — at any point in its life, before or after
publishing. Titles shown in the picker come from Telegram, so groups read as names rather
than IDs. There is nothing to assign per person: membership *is* Telegram group membership,
so adding or removing someone from the group is what grants or revokes access.

An event with no groups is open to everyone. A restricted one is listed, opened, and joinable
only by members of at least one of its groups; to everyone else it reads as not found,
including through a bot deep link. Anyone already signed up keeps seeing an event that is
restricted afterwards, so they can still cancel; once they cancel, the restriction applies.

Membership answers are cached in `chat_members` for 5 minutes
(`MEMBERSHIP_TTL_MS` in `apps/server/src/core/membership.ts`), so leaving a group takes
up to that long to close an event off. If Telegram cannot answer, the last known answer
stands; with no answer on record the event stays closed, so an unreachable group never
opens an event to everyone.

## The event chat

An event can have an **event chat**: the Telegram group everyone who takes a spot is invited
into. Admins pick it on the event form, from the same city's chats the restriction picker
uses, and it is deliberately a separate setting — "who may see this event" and "where
its runners end up" are different questions, and an event open to the whole world is exactly
where a chat invite earns its keep.

Newcomers are on **trial**: turn up and the chat is yours, skip the run and you are removed
again. People who were in the chat before the event never enter that arrangement at all.

### How someone gets in

**A bot cannot add anyone to a group.** The Bot API has no such method — invite links are the
only mechanism Telegram offers. So each guest is sent their own single-use link in a DM and
taps it themselves. The link is scoped to one person and expires 12 hours after the event
starts (or an hour from issue, whichever is later, so a booking made weeks ahead still works
on the day).

Only confirmed spots get one. Someone still in the queue has no spot yet, and is invited the
moment an offer promotes them. Banned users are never invited, even if the ban lands after
they signed up.

### How someone is removed

An hour after an organizer presses **End event** (`SETTLEMENT_GRACE_MS` in
`apps/server/src/core/guests.ts`), every trial resting on it is settled. An event that
leaves `published` some other way — canceled, closed, or pushed back to draft — settles
straight away, so no guest is ever stranded in the chat by an event nobody is running:

- **Checked in** → the trial is over and they keep their place for good.
- **Never showed, but holds a spot at another run into the same chat** → the trial is carried
  over to that run rather than settled. Without this, booking a second event would quietly
  buy a permanent seat without ever turning up.
- **Otherwise** → their unused invite link is revoked and they are removed from the chat.

Removal is a ban followed immediately by an unban, which kicks without blocking them from
coming back later. Their messages are left alone.

The hour of grace exists because marking attendance by hand stays open after an event ends —
correcting a roster is part of the job — and a removal cannot be undone from here: the person
would need a whole new invite. **Reopen event** inside the window calls it off entirely.

### Who is never removed

Only people listed in `chat_guests` are ever touched, and a row is written there only when
Telegram confirms, at the moment of inviting, that the person is *outside* the chat. A
long-standing member has no row, is never on trial, and is invisible to the removal sweep.

That confirmation is a live `getChatMember` call rather than a read of the `chat_members`
cache, on purpose: the cache records a *failed* lookup as "not a member" so that an
unreachable group closes an event rather than opening it, and trusting that here would put a
real member on trial and eventually throw them out.

### Bot permissions

On top of the administrator rights restricted events already need, the bot must hold
**Invite Users via Link** and **Ban Users** in any chat used as an event chat. Without the
first it cannot mint invite links; without the second it cannot remove a no-show. Failures
are logged per call and retried on the next sweep rather than being fatal.

### Reconciliation

Invitations and removals are not fired from the join or end handlers. A sweep runs every 60
seconds (`apps/server/src/sweeper.ts`, a slower lane than the 30-second offer sweep since
nothing here is racing a deadline) and reconciles from state, so it converges on the same
result no matter what happened while the server was down — and setting an event chat on an
event that **already has people signed up** invites all of them on the next pass, which is how
you retrofit the feature onto a run that is already filling up.

Each definite answer Telegram gives about membership is written into the `chat_members` cache
and trusted for `MEMBERSHIP_TTL_MS` (5 minutes), so the regulars holding a spot are asked about
once per window rather than on every pass. That matters most for an open event, which has no
`event_chats` rows and so nothing else filling that cache. The window has to expire, though:
someone who **leaves** the chat has to become invitable again, so a "member" answer is never
trusted indefinitely — expect up to 5 minutes before a departure is noticed.
