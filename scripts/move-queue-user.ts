// Moves a waitlisted user to an exact queue position for one event.
//
//   docker compose exec -T app bun run scripts/move-queue-user.ts <event-id> <user-id> <position>
//
// Queue order is derived from registrations.created_at, then registrations.id.
// This script rewrites ordering timestamps for the whole queue in one transaction
// so timestamp ties cannot leave the selected user in the wrong position.
import { Database } from "bun:sqlite";

const [eventId, userId, requestedPosition] = process.argv.slice(2).map(Number);

if (
  !Number.isSafeInteger(eventId) || eventId <= 0
  || !Number.isSafeInteger(userId) || userId <= 0
  || !Number.isSafeInteger(requestedPosition) || requestedPosition <= 0
) {
  console.error("Usage: bun run scripts/move-queue-user.ts <event-id> <user-id> <position>");
  process.exit(1);
}

const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db");

type QueueRow = { id: number; user_id: number; created_at: number };

try {
  db.transaction(() => {
    const event = db.query<{ title: string }, [number]>("SELECT title FROM events WHERE id = ?").get(eventId);
    if (!event) throw new Error(`No event ${eventId}.`);

    const queue = db.query<QueueRow, [number]>(`
      SELECT id, user_id, created_at
      FROM registrations
      WHERE event_id = ? AND status = 'waitlisted'
      ORDER BY created_at, id
    `).all(eventId);

    const currentIndex = queue.findIndex((row) => row.user_id === userId);
    if (currentIndex === -1) throw new Error(`User ${userId} is not waitlisted for event ${eventId}.`);
    if (requestedPosition > queue.length) {
      throw new Error(`Position must be between 1 and ${queue.length} for this event.`);
    }

    const [selected] = queue.splice(currentIndex, 1);
    if (!selected) throw new Error("Could not read the selected registration.");
    queue.splice(requestedPosition - 1, 0, selected);

    const firstTimestamp = Math.min(...queue.map((row) => row.created_at));
    const update = db.query<void, [number, number]>("UPDATE registrations SET created_at = ? WHERE id = ?");
    queue.forEach((row, index) => update.run(firstTimestamp + index, row.id));

    console.log(`Moved user ${userId} from position ${currentIndex + 1} to ${requestedPosition} in event ${eventId} — ${event.title}.`);
  })();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
