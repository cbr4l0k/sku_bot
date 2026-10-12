import { Effect } from "effect";
import { Database } from "../services";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * Publishing a draft from chat does exactly what the admin route does for
 * `status: "published"`: the status flips, and everything else (chat invites,
 * reminders, sign-ups) follows from it. Only a draft can be published this way.
 */
export const publishDraft = Effect.fn("drafts.publishDraft")(function* (eventId: number, now: Date) {
  const db = yield* Database;
  const changed = db.$client.query("UPDATE events SET status = 'published', updated_at = ? WHERE id = ? AND status = 'draft'")
    .run(seconds(now), eventId).changes;
  return changed > 0;
});

/**
 * Skipping a raised draft removes it, as the app's "Delete draft" does. A draft that
 * somehow took money is kept: its payment history must survive.
 */
export const discardDraft = Effect.fn("drafts.discardDraft")(function* (eventId: number) {
  const db = yield* Database;
  return db.$client.transaction((): "discarded" | "not_draft" | "has_orders" => {
    const event = db.$client.query<{ status: string }, [number]>("SELECT status FROM events WHERE id = ?").get(eventId);
    if (event?.status !== "draft") return "not_draft";
    if (db.$client.query("SELECT 1 FROM ticket_orders WHERE event_id = ? LIMIT 1").get(eventId)) return "has_orders";
    db.$client.query("DELETE FROM events WHERE id = ?").run(eventId);
    return "discarded";
  })();
});
