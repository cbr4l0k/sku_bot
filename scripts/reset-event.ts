// Resets an event's registrations, queue, and local sales state while keeping
// the event, ticket tiers, products, organizers, and configuration.
//
// Preview (default):
//   docker compose exec -T app bun run scripts/reset-event.ts <event-id>
// Apply (permanently erases this event's local financial audit records):
//   docker compose exec -T app bun run scripts/reset-event.ts <event-id> --apply
import { Database } from "bun:sqlite";

const eventId = Number(process.argv[2]);
const apply = process.argv.slice(3).includes("--apply");

if (!Number.isSafeInteger(eventId) || eventId <= 0) {
  console.error("Usage: bun run scripts/reset-event.ts <event-id> [--apply]");
  process.exit(1);
}

const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db");
db.exec("PRAGMA foreign_keys = ON");

type EventRow = { id: number; title: string };
type OrderRow = { id: string; user_id: number; status: string; amount_minor: number; currency: string };
type Counts = {
  registrations: number;
  offers: number;
  orders: number;
  items: number;
  attempts: number;
  refunds: number;
};

try {
  const event = db.query<EventRow, [number]>("SELECT id, title FROM events WHERE id = ?").get(eventId);
  if (!event) throw new Error(`No event ${eventId}.`);

  const orders = db.query<OrderRow, [number]>(`
    SELECT id, user_id, status, amount_minor, currency
    FROM ticket_orders
    WHERE event_id = ?
    ORDER BY created_at, id
  `).all(eventId);

  const unsafeOrders = orders.filter((order) => order.status !== "refunded" && order.status !== "canceled");
  console.log(`Event ${event.id} — ${event.title}`);
  if (orders.length > 0) console.table(orders);
  if (unsafeOrders.length > 0) {
    console.error("Refusing reset because these orders are not locally refunded or canceled:");
    console.table(unsafeOrders);
    throw new Error("Finish or reconcile all payments first. Nothing was deleted.");
  }

  const counts = db.query<Counts, [number]>(`
    SELECT
      (SELECT count(*) FROM registrations WHERE event_id = ?1) AS registrations,
      (SELECT count(*) FROM waitlist_offers WHERE event_id = ?1) AS offers,
      (SELECT count(*) FROM ticket_orders WHERE event_id = ?1) AS orders,
      (SELECT count(*) FROM order_items WHERE order_id IN (SELECT id FROM ticket_orders WHERE event_id = ?1)) AS items,
      (SELECT count(*) FROM payment_attempts WHERE order_id IN (SELECT id FROM ticket_orders WHERE event_id = ?1)) AS attempts,
      (SELECT count(*) FROM refunds WHERE order_id IN (SELECT id FROM ticket_orders WHERE event_id = ?1)) AS refunds
  `).get(eventId);
  if (!counts) throw new Error("Could not calculate reset totals.");
  console.table([counts]);

  if (!apply) {
    console.log("Preview only: the rows above would be permanently deleted.");
    console.log("Run the same command with --apply to reset the event.");
  } else {
    const reset = db.transaction(() => {
      const unsafe = db.query<{ id: string }, [number]>(`
        SELECT id FROM ticket_orders
        WHERE event_id = ? AND status NOT IN ('refunded', 'canceled')
        LIMIT 1
      `).get(eventId);
      if (unsafe) throw new Error("Payment state changed; nothing was deleted.");

      db.query(`DELETE FROM refunds WHERE order_id IN (SELECT id FROM ticket_orders WHERE event_id = ?)`).run(eventId);
      db.query(`DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM ticket_orders WHERE event_id = ?)`).run(eventId);
      db.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM ticket_orders WHERE event_id = ?)`).run(eventId);
      db.query("DELETE FROM ticket_orders WHERE event_id = ?").run(eventId);
      db.query("DELETE FROM waitlist_offers WHERE event_id = ?").run(eventId);
      db.query("DELETE FROM registrations WHERE event_id = ?").run(eventId);
    });

    reset.immediate();
    console.log(`Event ${event.id} — ${event.title} was reset.`);
    console.log("Deleted rows:");
    console.table([counts]);
    console.log("Chat guest tracking was preserved so the bot does not forget whom it invited to Telegram.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
