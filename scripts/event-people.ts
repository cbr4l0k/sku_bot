// Lists registrations and payment state for one event before an operator cleanup.
//
//   docker compose exec -T app bun run scripts/event-people.ts <event-id>
//
// Read-only. User ids printed here can be passed to remove-event-person.ts.
import { Database } from "bun:sqlite";

const eventId = Number(process.argv[2]);
if (!Number.isSafeInteger(eventId) || eventId <= 0) {
  console.error("Usage: bun run scripts/event-people.ts <event-id>");
  process.exit(1);
}

const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db", { readonly: true });

type EventRow = { id: number; title: string };
type PersonRow = {
  user_id: number;
  name: string;
  username: string | null;
  registration_status: string;
  payment_statuses: string | null;
};

try {
  const event = db.query<EventRow, [number]>(`
    SELECT id, title
    FROM events
    WHERE id = ?
  `).get(eventId);
  if (!event) throw new Error(`No event ${eventId}.`);

  const people = db.query<PersonRow, [number]>(`
    SELECT
      r.user_id,
      u.first_name || COALESCE(' ' || u.last_name, '') AS name,
      u.username,
      r.status AS registration_status,
      (
        SELECT group_concat(o.status, ', ')
        FROM ticket_orders o
        WHERE o.event_id = r.event_id AND o.user_id = r.user_id
      ) AS payment_statuses
    FROM registrations r
    JOIN users u ON u.id = r.user_id
    WHERE r.event_id = ?
    ORDER BY r.created_at, r.id
  `).all(eventId);

  console.log(`Event ${event.id} — ${event.title}`);
  console.table(people);
  console.log(`${people.length} registration row(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
