// Exports one event to an .xlsx workbook: who is coming, what they paid, and what
// has to be handed to them on the day.
//
//   docker compose exec -T app bun run scripts/export-event.ts <event-id> - > event.xlsx
//
// Read-only. Six tabs — Event, Registrations, Orders, Order items, Sales, Refunds —
// with frozen headers and filters on the record tabs. Times are Europe/Moscow, which
// every branch currently keeps; money is in rubles so Excel can sum a column of it.
import { Database } from "bun:sqlite";

import { buildXlsx, type Cell, type Sheet } from "./xlsx";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const eventId = Number(args[0]);
if (!Number.isSafeInteger(eventId) || eventId <= 0) {
  console.error("Usage: bun run scripts/export-event.ts <event-id> [output.xlsx | -]");
  console.error("       '-' writes the workbook to stdout; the default is ./event-<id>.xlsx");
  process.exit(1);
}
const output = args[1] ?? `./event-${eventId}.xlsx`;

const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db", { readonly: true });

/** Every branch is UTC+3 today; the bot formats event cards the same way. */
const TIMEZONE = "Europe/Moscow";
const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "2026-09-09 19:30" — sorts correctly as text, and reads the same in any locale. */
const when = (seconds: number | null): string | null =>
  seconds === null ? null : dateFormat.format(new Date(seconds * 1000));

/** Kopecks to rubles. Excel gets a number, so a column of them can be summed. */
const money = (minor: number | null): number | null => (minor === null ? null : Math.round(minor) / 100);

const fullName = (first: string, last: string | null): string => (last === null ? first : `${first} ${last}`);

const at = (username: string | null): string | null => (username === null ? null : `@${username}`);

const yesNo = (value: number): string => (value === 1 ? "yes" : "no");

/** Orders whose money is actually in the club's account. */
const PAID = "('payment_succeeded', 'fulfilled')";

type EventRow = {
  id: number;
  city: string;
  title: string;
  description: string;
  starts_at: number;
  location: string;
  location_url: string | null;
  capacity: number | null;
  waitlist_enabled: number;
  status: string;
  ended_at: number | null;
  home_chat_id: number | null;
  created_at: number;
  organizers: string | null;
};

type RegistrationRow = {
  user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  phone: string | null;
  locale: string;
  status: string;
  queue_position: number | null;
  created_at: number;
  checked_in_at: number | null;
  order_statuses: string | null;
  paid_minor: number;
  extras: string | null;
};

type OrderRow = {
  id: string;
  user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  status: string;
  ticket_name: string | null;
  amount_minor: number;
  currency: string;
  created_at: number;
  paid_at: number | null;
  fulfilled_at: number | null;
  canceled_at: number | null;
  refunded_at: number | null;
  refunded_minor: number;
  payment_ids: string | null;
};

type ItemRow = {
  order_id: string;
  order_status: string;
  user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  kind: string;
  name: string;
  variant_name: string | null;
  unit_amount_minor: number;
  quantity: number;
};

type SalesRow = {
  kind: string;
  name: string;
  variant: string;
  paid_quantity: number;
  paid_minor: number;
  refunded_quantity: number;
  refunded_minor: number;
  unsettled_quantity: number;
};

type RefundRow = {
  id: string;
  order_id: string;
  user_id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  amount_minor: number;
  status: string;
  reason: string;
  failure_reason: string | null;
  provider_refund_id: string | null;
  created_at: number;
  updated_at: number;
};

try {
  const event = db.query<EventRow, [number]>(`
    SELECT
      e.*,
      (
        SELECT group_concat(u.first_name || COALESCE(' ' || u.last_name, '') || COALESCE(' (@' || u.username || ')', ''), ', ')
        FROM event_organizers eo
        JOIN users u ON u.id = eo.user_id
        WHERE eo.event_id = e.id
      ) AS organizers
    FROM events e
    WHERE e.id = ?
  `).get(eventId);
  if (!event) throw new Error(`No event ${eventId}.`);

  const registrations = db.query<RegistrationRow, [number]>(`
    SELECT
      r.user_id,
      u.first_name,
      u.last_name,
      u.username,
      u.phone,
      u.locale,
      r.status,
      CASE WHEN r.status = 'waitlisted' THEN (
        SELECT COUNT(*)
        FROM registrations q
        WHERE q.event_id = r.event_id
          AND q.status = 'waitlisted'
          AND (q.created_at < r.created_at OR (q.created_at = r.created_at AND q.id <= r.id))
      ) END AS queue_position,
      r.created_at,
      r.checked_in_at,
      (
        SELECT group_concat(o.status, ', ')
        FROM ticket_orders o
        WHERE o.event_id = r.event_id AND o.user_id = r.user_id
      ) AS order_statuses,
      COALESCE((
        SELECT SUM(o.amount_minor)
        FROM ticket_orders o
        WHERE o.event_id = r.event_id AND o.user_id = r.user_id AND o.status IN ${PAID}
      ), 0) AS paid_minor,
      (
        SELECT group_concat(i.name || COALESCE(' / ' || i.variant_name, '') || ' x' || i.quantity, '; ')
        FROM order_items i
        JOIN ticket_orders o ON o.id = i.order_id
        WHERE o.event_id = r.event_id AND o.user_id = r.user_id
          AND o.status IN ${PAID} AND i.kind <> 'ticket'
      ) AS extras
    FROM registrations r
    JOIN users u ON u.id = r.user_id
    WHERE r.event_id = ?
    ORDER BY r.created_at, r.id
  `).all(eventId);

  const orders = db.query<OrderRow, [number]>(`
    SELECT
      o.id,
      o.user_id,
      u.first_name,
      u.last_name,
      u.username,
      o.status,
      o.ticket_name,
      o.amount_minor,
      o.currency,
      o.created_at,
      o.paid_at,
      o.fulfilled_at,
      o.canceled_at,
      o.refunded_at,
      COALESCE((
        SELECT SUM(f.amount_minor) FROM refunds f WHERE f.order_id = o.id AND f.status = 'succeeded'
      ), 0) AS refunded_minor,
      (
        SELECT group_concat(p.provider_payment_id, ', ')
        FROM payment_attempts p
        WHERE p.order_id = o.id AND p.provider_payment_id IS NOT NULL
      ) AS payment_ids
    FROM ticket_orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.event_id = ?
    ORDER BY o.created_at, o.id
  `).all(eventId);

  const items = db.query<ItemRow, [number]>(`
    SELECT
      i.order_id,
      o.status AS order_status,
      o.user_id,
      u.first_name,
      u.last_name,
      u.username,
      i.kind,
      i.name,
      i.variant_name,
      i.unit_amount_minor,
      i.quantity
    FROM order_items i
    JOIN ticket_orders o ON o.id = i.order_id
    JOIN users u ON u.id = o.user_id
    WHERE o.event_id = ?
    ORDER BY o.created_at, i.id
  `).all(eventId);

  // The pick list: how many of each shirt, in each size, have actually been paid for.
  const sales = db.query<SalesRow, [number]>(`
    SELECT
      i.kind,
      i.name,
      COALESCE(i.variant_name, '') AS variant,
      SUM(CASE WHEN o.status IN ${PAID} THEN i.quantity ELSE 0 END) AS paid_quantity,
      SUM(CASE WHEN o.status IN ${PAID} THEN i.quantity * i.unit_amount_minor ELSE 0 END) AS paid_minor,
      SUM(CASE WHEN o.status = 'refunded' THEN i.quantity ELSE 0 END) AS refunded_quantity,
      SUM(CASE WHEN o.status = 'refunded' THEN i.quantity * i.unit_amount_minor ELSE 0 END) AS refunded_minor,
      SUM(CASE WHEN o.status IN ('awaiting_payment', 'cancel_pending', 'refund_pending', 'refund_failed')
          THEN i.quantity ELSE 0 END) AS unsettled_quantity
    FROM order_items i
    JOIN ticket_orders o ON o.id = i.order_id
    WHERE o.event_id = ?
    GROUP BY i.kind, i.name, variant
    ORDER BY i.kind, i.name, variant
  `).all(eventId);

  const refunds = db.query<RefundRow, [number]>(`
    SELECT
      f.id,
      f.order_id,
      o.user_id,
      u.first_name,
      u.last_name,
      u.username,
      f.amount_minor,
      f.status,
      f.reason,
      f.failure_reason,
      f.provider_refund_id,
      f.created_at,
      f.updated_at
    FROM refunds f
    JOIN ticket_orders o ON o.id = f.order_id
    JOIN users u ON u.id = o.user_id
    WHERE o.event_id = ?
    ORDER BY f.created_at, f.id
  `).all(eventId);

  const countBy = (status: string): number => registrations.filter((row) => row.status === status).length;
  const sum = <T>(rows: T[], pick: (row: T) => number): number => rows.reduce((total, row) => total + pick(row), 0);

  const paidOrders = orders.filter((order) => order.status === "payment_succeeded" || order.status === "fulfilled");
  const grossMinor = sum(paidOrders, (order) => order.amount_minor);
  const refundedMinor = sum(orders, (order) => order.refunded_minor);

  const summary: Cell[][] = [
    ["Event id", event.id],
    ["Title", event.title],
    ["Branch", event.city],
    ["Status", event.status],
    ["Starts at", when(event.starts_at)],
    ["Ended at", when(event.ended_at)],
    ["Location", event.location],
    ["Location link", event.location_url],
    ["Capacity", event.capacity ?? "unlimited"],
    ["Waitlist enabled", yesNo(event.waitlist_enabled)],
    ["Event chat id", event.home_chat_id],
    ["Organizers", event.organizers],
    ["Created at", when(event.created_at)],
    [null, null],
    ["Registered", countBy("registered")],
    ["Checked in", countBy("checked_in")],
    ["Waitlisted", countBy("waitlisted")],
    ["Canceled", countBy("canceled")],
    ["Registration rows", registrations.length],
    [null, null],
    ["Paid orders", paidOrders.length],
    ["Gross paid, RUB", money(grossMinor)],
    ["Refunded, RUB", money(refundedMinor)],
    ["Net, RUB", money(grossMinor - refundedMinor)],
    ["Orders awaiting payment", orders.filter((order) => order.status === "awaiting_payment").length],
    [null, null],
    ["Exported at", when(Math.floor(Date.now() / 1000))],
    ["Times shown in", TIMEZONE],
  ];

  const sheets: Sheet[] = [
    { name: "Event", columns: ["Field", "Value"], rows: summary, filter: false },
    {
      name: "Registrations",
      columns: [
        "User id", "Name", "Username", "Phone", "Status", "Queue #",
        "Registered at", "Checked in at", "Paid, RUB", "Order statuses", "Extras", "Locale",
      ],
      rows: registrations.map((row) => [
        row.user_id,
        fullName(row.first_name, row.last_name),
        at(row.username),
        row.phone,
        row.status,
        row.queue_position,
        when(row.created_at),
        when(row.checked_in_at),
        money(row.paid_minor),
        row.order_statuses,
        row.extras,
        row.locale,
      ]),
    },
    {
      name: "Orders",
      columns: [
        "Order id", "User id", "Name", "Username", "Status", "Ticket", "Amount, RUB", "Currency",
        "Refunded, RUB", "Created at", "Paid at", "Fulfilled at", "Canceled at", "Refunded at", "ЮKassa payment id",
      ],
      rows: orders.map((row) => [
        row.id,
        row.user_id,
        fullName(row.first_name, row.last_name),
        at(row.username),
        row.status,
        row.ticket_name,
        money(row.amount_minor),
        row.currency,
        money(row.refunded_minor),
        when(row.created_at),
        when(row.paid_at),
        when(row.fulfilled_at),
        when(row.canceled_at),
        when(row.refunded_at),
        row.payment_ids,
      ]),
    },
    {
      name: "Order items",
      columns: [
        "Order id", "Order status", "User id", "Name", "Username",
        "Kind", "Item", "Variant", "Unit, RUB", "Quantity", "Line total, RUB",
      ],
      rows: items.map((row) => [
        row.order_id,
        row.order_status,
        row.user_id,
        fullName(row.first_name, row.last_name),
        at(row.username),
        row.kind,
        row.name,
        row.variant_name,
        money(row.unit_amount_minor),
        row.quantity,
        money(row.unit_amount_minor * row.quantity),
      ]),
    },
    {
      name: "Sales",
      columns: [
        "Kind", "Item", "Variant", "Paid quantity", "Paid, RUB",
        "Refunded quantity", "Refunded, RUB", "Unsettled quantity",
      ],
      rows: sales.map((row) => [
        row.kind,
        row.name,
        row.variant === "" ? null : row.variant,
        row.paid_quantity,
        money(row.paid_minor),
        row.refunded_quantity,
        money(row.refunded_minor),
        row.unsettled_quantity,
      ]),
    },
    {
      name: "Refunds",
      columns: [
        "Refund id", "Order id", "User id", "Name", "Username", "Amount, RUB",
        "Status", "Reason", "Failure reason", "ЮKassa refund id", "Created at", "Updated at",
      ],
      rows: refunds.map((row) => [
        row.id,
        row.order_id,
        row.user_id,
        fullName(row.first_name, row.last_name),
        at(row.username),
        money(row.amount_minor),
        row.status,
        row.reason,
        row.failure_reason,
        row.provider_refund_id,
        when(row.created_at),
        when(row.updated_at),
      ]),
    },
  ];

  const workbook = buildXlsx(sheets);

  if (output === "-") {
    process.stdout.write(workbook);
  } else {
    await Bun.write(output, workbook);
  }

  // Progress goes to stderr so that `... - > event.xlsx` stays a clean binary stream.
  console.error(
    `Event ${event.id} — ${event.title}\n` +
      `  ${registrations.length} registration(s), ${orders.length} order(s), ` +
      `${items.length} item row(s), ${refunds.length} refund(s)\n` +
      `  ${output === "-" ? "written to stdout" : `written to ${output}`} (${(workbook.length / 1024).toFixed(1)} KiB)`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
