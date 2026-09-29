// Empties one event's waiting list. People already holding a spot are untouched.
//
// Queued people are canceled exactly as if they had left the queue themselves:
// their registration becomes `canceled` (history and stats survive, and they may
// join again) and any pending spot offer is superseded, so an Accept button still
// on screen answers "spot taken" instead of letting them in.
//
// Preview (default):
//   docker compose exec -T app bun run scripts/clear-queue.ts <event-id>
// Apply:
//   docker compose exec -T app bun run scripts/clear-queue.ts <event-id> --apply
import { Database } from "bun:sqlite";

export type QueuedPerson = { user_id: number; name: string; username: string | null; offer: string | null };

export const queueOf = (db: Database, eventId: number): QueuedPerson[] => db.query<QueuedPerson, [number]>(`
  SELECT
    r.user_id,
    u.first_name || COALESCE(' ' || u.last_name, '') AS name,
    u.username,
    (SELECT 'pending offer' FROM waitlist_offers o
      WHERE o.event_id = r.event_id AND o.user_id = r.user_id AND o.status = 'pending' LIMIT 1) AS offer
  FROM registrations r
  JOIN users u ON u.id = r.user_id
  WHERE r.event_id = ? AND r.status = 'waitlisted'
  ORDER BY r.created_at, r.id
`).all(eventId);

export const clearQueue = (db: Database, eventId: number, now: Date) => db.transaction(() => {
  const timestamp = Math.floor(now.getTime() / 1000);
  // Scoped to queued people only: a pending offer is never held by someone registered.
  const offers = db.query(`
    UPDATE waitlist_offers SET status = 'superseded'
    WHERE event_id = ?1 AND status = 'pending' AND user_id IN (
      SELECT user_id FROM registrations WHERE event_id = ?1 AND status = 'waitlisted'
    )`).run(eventId).changes;
  const registrations = db.query(
    "UPDATE registrations SET status = 'canceled', updated_at = ? WHERE event_id = ? AND status = 'waitlisted'",
  ).run(timestamp, eventId).changes;
  return { registrationsCanceled: registrations, offersSuperseded: offers };
}).immediate();

if (import.meta.main) {
  const eventId = Number(process.argv[2]);
  const apply = process.argv.slice(3).includes("--apply");
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    console.error("Usage: bun run scripts/clear-queue.ts <event-id> [--apply]");
    process.exit(1);
  }

  const databasePath = process.env.DATABASE_PATH ?? "./data/sku.db";
  const db = apply ? new Database(databasePath) : new Database(databasePath, { readonly: true });
  db.run("PRAGMA foreign_keys = ON");

  try {
    const event = db.query<{ title: string }, [number]>("SELECT title FROM events WHERE id = ?").get(eventId);
    if (!event) throw new Error(`No event ${eventId}.`);
    console.log(`Event ${eventId} — ${event.title}`);

    const queue = queueOf(db, eventId);
    if (queue.length === 0) {
      console.log("The queue is already empty.");
    } else {
      console.table(queue.map((person, index) => ({ position: index + 1, ...person })));
      if (!apply) {
        console.log(`Preview only: these ${queue.length} people would be taken off the queue.`);
        console.log("Run the same command with --apply to clear it.");
      } else {
        console.log("Queue cleared:", clearQueue(db, eventId, new Date()));
        console.log("Nobody was notified. Registered people were not touched.");
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
