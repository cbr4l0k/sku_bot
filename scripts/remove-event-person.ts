// Removes one person's registration and waitlist offers from an event while
// preserving all payment/refund records as a financial audit trail.
//
// Preview (default):
//   docker compose exec -T app bun run scripts/remove-event-person.ts <event-id> <user-id>
// Apply:
//   docker compose exec -T app bun run scripts/remove-event-person.ts <event-id> <user-id> --apply
import { Database } from "bun:sqlite";

const eventId = Number(process.argv[2]);
const userId = Number(process.argv[3]);
const apply = process.argv.slice(4).includes("--apply");

if (!Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
  console.error("Usage: bun run scripts/remove-event-person.ts <event-id> <user-id> [--apply]");
  process.exit(1);
}

const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db");
db.exec("PRAGMA foreign_keys = ON");

type PersonRow = {
  event_title: string;
  name: string;
  username: string | null;
  registration_status: string;
};
type OrderRow = { id: string; status: string; amount_minor: number; currency: string };

try {
  const person = db.query<PersonRow, [number, number]>(`
    SELECT
      e.title AS event_title,
      u.first_name || COALESCE(' ' || u.last_name, '') AS name,
      u.username,
      r.status AS registration_status
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    JOIN users u ON u.id = r.user_id
    WHERE r.event_id = ? AND r.user_id = ?
  `).get(eventId, userId);
  if (!person) throw new Error(`User ${userId} has no registration for event ${eventId}.`);

  const orders = db.query<OrderRow, [number, number]>(`
    SELECT id, status, amount_minor, currency
    FROM ticket_orders
    WHERE event_id = ? AND user_id = ?
    ORDER BY created_at, id
  `).all(eventId, userId);

  console.log(`Event ${eventId} — ${person.event_title}`);
  console.log(`Person ${userId} — ${person.name}${person.username ? ` (@${person.username})` : ""}`);
  console.log(`Registration: ${person.registration_status}`);
  if (orders.length > 0) console.table(orders);

  const unsafeTicketOrders = db.query<OrderRow, [number, number]>(`
    SELECT id, status, amount_minor, currency
    FROM ticket_orders
    WHERE event_id = ? AND user_id = ? AND ticket_tier_id IS NOT NULL
      AND status NOT IN ('refunded', 'canceled')
  `).all(eventId, userId);
  if (unsafeTicketOrders.length > 0) {
    console.error("Refusing cleanup because a paid ticket is not locally refunded or canceled:");
    console.table(unsafeTicketOrders);
    throw new Error("Finish or reconcile the refund first. Nothing was deleted.");
  }

  if (!apply) {
    console.log("Preview only: the registration and waitlist offers would be deleted.");
    console.log("Run the same command with --apply to perform the cleanup.");
  } else {
    const remove = db.transaction(() => {
      // Check again under the write transaction so a concurrent checkout cannot
      // slip between the preview and deletion.
      const unsafe = db.query<{ id: string }, [number, number]>(`
        SELECT id FROM ticket_orders
        WHERE event_id = ? AND user_id = ? AND ticket_tier_id IS NOT NULL
          AND status NOT IN ('refunded', 'canceled')
        LIMIT 1
      `).get(eventId, userId);
      if (unsafe) throw new Error("Payment state changed; nothing was deleted.");

      const offers = db.query("DELETE FROM waitlist_offers WHERE event_id = ? AND user_id = ?").run(eventId, userId);
      const registration = db.query("DELETE FROM registrations WHERE event_id = ? AND user_id = ?").run(eventId, userId);
      if (registration.changes !== 1) throw new Error("Registration changed before cleanup; nothing was deleted.");
      return { registrationsDeleted: registration.changes, waitlistOffersDeleted: offers.changes };
    });

    console.log("Cleanup complete:", remove.immediate());
    console.log("Payment and refund history was preserved.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
