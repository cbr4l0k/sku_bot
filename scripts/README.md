# Maintenance scripts

Run these commands from the repository root. In the production Docker setup, the
scripts use `DATABASE_PATH=/app/data/sku.db` and the ЮKassa credentials already
provided to the `app` service.

After adding or changing a script, rebuild the image before trying to run it:

```sh
docker compose up -d --build
```

In the examples below:

- `EVENT_ID` is the numeric database id. For `evt_17`, use `17`.
- `USER_ID` is the person's numeric Telegram user id, as printed by
  `event-people.ts`.
- `REFUND_OR_PAYMENT_ID` is either the ЮKassa refund id or the original payment id.
- Commands that support `--apply` are previews by default. Always run the preview
  first and check its output before adding `--apply`.

## `backup.ts`

Creates a consistent SQLite backup while the application is running. It includes
changes from the WAL file and writes only the binary database to standard output.

```sh
docker compose exec -T app bun run scripts/backup.ts > sku-$(date +%F).db
```

Keep `-T`: allocating a TTY can corrupt the binary output. The redirect happens on
the host, so the resulting file is created in your current host directory.

This script is read-only with respect to the live database. Take a backup before
using `reset-event.ts` or doing unusual production repair work.

## `event-people.ts`

Lists every registration for an event with the person's numeric user id,
registration status, and local payment statuses. Use it to find the `USER_ID` for
the other event-maintenance commands.

```sh
docker compose exec -T app bun run scripts/event-people.ts EVENT_ID
```

Example:

```sh
docker compose exec -T app bun run scripts/event-people.ts 17
```

This script is read-only. A person can still appear here with registration status
`canceled`; use `remove-event-person.ts` to remove that historical registration row.

## `remove-event-person.ts`

Removes one person's registration and waitlist offers from one event. It does not
delete the user, their ЮKassa payment attempts, orders, or refund audit history.

Preview:

```sh
docker compose exec -T app bun run scripts/remove-event-person.ts EVENT_ID USER_ID
```

Apply after checking the event, person, and payment table printed by the preview:

```sh
docker compose exec -T app bun run scripts/remove-event-person.ts EVENT_ID USER_ID --apply
```

For a paid ticket, the script refuses to write unless the local order is
`refunded` or `canceled`. If the refund was completed in the ЮKassa dashboard but
the local order still says `fulfilled` or `refund_pending`, run
`reconcile-yookassa-refund.ts` first.

## `reconcile-yookassa-refund.ts`

Repairs local state after a refund was created directly in the ЮKassa dashboard or
its webhook was missed. It fetches the refund from ЮKassa and matches it to the
local order using the original provider payment id.

All application refund paths perform this lookup automatically before creating a new
refund, including admin requests, participant cancellations, event cancellations, and
late-payment recovery. Use this script as a diagnostic or recovery fallback when the
Mini App is unavailable or an older deployed version left inconsistent local state.

You may pass either identifier. If the value returns 404 as a refund id, the script
treats it as a payment id and asks ЮKassa for its refunds. It proceeds only when it
can identify exactly one full refund. An empty result usually means the id belongs
to a different shop or test/production environment, or contains a typo.

Preview the remote refund and matched local order:

```sh
docker compose exec -T app bun run scripts/reconcile-yookassa-refund.ts REFUND_OR_PAYMENT_ID
```

Apply the authoritative ЮKassa status locally:

```sh
docker compose exec -T app bun run scripts/reconcile-yookassa-refund.ts REFUND_OR_PAYMENT_ID --apply
```

The preview makes a read request to ЮKassa but does not change the database. The
apply command updates the refund, order, and ticket registration consistently.
It requires `YOOKASSA_SHOP_ID` and `YOOKASSA_SECRET_KEY`.

Only a full refund whose amount and currency exactly match the local order can
close the whole order. The script rejects partial refunds instead of incorrectly
removing the participant's paid ticket.

Typical recovery flow:

```sh
docker compose exec -T app bun run scripts/reconcile-yookassa-refund.ts REFUND_OR_PAYMENT_ID
docker compose exec -T app bun run scripts/reconcile-yookassa-refund.ts REFUND_OR_PAYMENT_ID --apply
docker compose exec -T app bun run scripts/remove-event-person.ts EVENT_ID USER_ID
docker compose exec -T app bun run scripts/remove-event-person.ts EVENT_ID USER_ID --apply
```

## `reset-event.ts`

Returns an event's local attendance and sales state to zero while keeping the event
itself, ticket tiers, products, organizers, chats, and configuration.

Preview all affected rows:

```sh
docker compose exec -T app bun run scripts/reset-event.ts EVENT_ID
```

Apply the reset:

```sh
docker compose exec -T app bun run scripts/reset-event.ts EVENT_ID --apply
```

The script deletes the event's:

- registrations and waitlist offers;
- orders and order items;
- payment attempts and refund records.

This permanently erases the event's local financial audit history. The script
refuses to run if any order is not locally `refunded` or `canceled`. Back up the
database first.

Telegram chat guest tracking is deliberately preserved. Removing those records
would make the bot forget whom it invited without actually removing anyone from
Telegram.

## `guests.ts`

Explains why each participant is or is not eligible for an event-chat invitation.
It displays the event state, cached Telegram membership, cache age, guest-trial
state, and the bot's resulting decision.

```sh
docker compose exec -T app bun run scripts/guests.ts EVENT_ID
```

Example:

```sh
docker compose exec -T app bun run scripts/guests.ts 17
```

This script is read-only. Telegram membership is cached, so a recent join or exit
can take up to five minutes to appear.

## `move-queue-user.ts`

Moves a waitlisted person to an exact one-based position in an event's queue. It
rewrites the queue ordering timestamps in a single database transaction.

```sh
docker compose exec -T app bun run scripts/move-queue-user.ts EVENT_ID USER_ID POSITION
```

Example—move user `123456789` to the front of event 17's queue:

```sh
docker compose exec -T app bun run scripts/move-queue-user.ts 17 123456789 1
```

Unlike the cleanup scripts, this command has no preview mode: a valid invocation
applies immediately. It fails without changes if the user is not waitlisted or the
position is outside the current queue.

## `export-event.ts`

Exports one event to an `.xlsx` workbook: the roster, the money, and the pick list
of merchandise to bring on the day. Use it to hand an organizer something they can
open in Excel, Numbers, or Google Sheets without touching the database.

```sh
docker compose exec -T app bun run scripts/export-event.ts EVENT_ID - > event-17.xlsx
```

Keep `-T` and the `-` argument: `-` writes the workbook to standard output, the
redirect happens on the host, and allocating a TTY would corrupt the binary file.
Progress is printed to standard error, so it never lands in the workbook.

Given a path instead of `-`, the script writes the file inside the container, which
is only useful for a mounted volume:

```sh
docker compose exec -T app bun run scripts/export-event.ts 17 /app/data/event-17.xlsx
```

Locally, the path form is the convenient one, and the default is `./event-<id>.xlsx`:

```sh
DATABASE_PATH=./data/sku.db bun run scripts/export-event.ts 17
```

The workbook has six tabs:

- **Event** — title, branch, status, start, location, capacity, organizers, plus
  head-count and money totals.
- **Registrations** — one row per registration: user id, name, `@username`, phone,
  status, queue position for waitlisted people, check-in time, what they paid, and
  any merchandise they are owed.
- **Orders** — one row per order with its ЮKassa payment id and every timestamp of
  the payment state machine.
- **Order items** — the priced line items behind those orders.
- **Sales** — quantity and revenue per ticket tier and per product variant, split
  into paid, refunded, and unsettled. This is the sheet to order shirts from.
- **Refunds** — the local refund audit trail, including failures.

Times are formatted in `Europe/Moscow`, the timezone every branch currently keeps.
Money is written in rubles as numbers, so a column can be summed in the spreadsheet;
the database stores kopecks. "Paid" means an order sitting in `payment_succeeded`
or `fulfilled`.

Someone who bought merchandise without holding a spot has no registration row, so
they appear on the Orders, Order items, and Sales tabs but not on Registrations.

This script is read-only. It writes the file with `scripts/xlsx.ts`, a small
SpreadsheetML writer in this repository, so exporting adds no dependency to the
image.

## Running outside Docker

For a local development database, set `DATABASE_PATH` explicitly and omit the
Docker prefix:

```sh
DATABASE_PATH=./data/sku.db bun run scripts/event-people.ts 17
```

Be especially careful not to point a destructive command at a copied production
database unless that is intentional.
