import { Effect } from "effect";
import { Database } from "../services";
import type { ReminderEffect } from "./types";

export const REMINDER_LEAD_SECONDS = 2 * 60 * 60; // 2 hours
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * Everyone holding a spot in a run that starts within the lead, once each. Someone
 * who signed up or was let in from the queue after the lead began has just chosen
 * this run and is not reminded of it. The mark is written before the DM goes out:
 * a lost reminder is better than a repeated one.
 */
export const sweepReminders = Effect.fn("reminders.sweepReminders")(function* (now: Date) {
  const db = yield* Database;
  return db.$client.transaction((): ReminderEffect[] => {
    const timestamp = seconds(now);
    const due = db.$client.query<{ id: number; user_id: number; event_id: number }, [number, number]>(`
      SELECT r.id, r.user_id, r.event_id
      FROM registrations r
      JOIN events e ON e.id = r.event_id
      WHERE e.reminders_enabled = 1 AND e.status = 'published' AND e.ended_at IS NULL
        AND e.starts_at > ? AND e.starts_at <= ? + ${REMINDER_LEAD_SECONDS}
        AND r.status = 'registered' AND r.is_staff = 0 AND r.reminded_at IS NULL
        AND r.updated_at <= e.starts_at - ${REMINDER_LEAD_SECONDS}
      ORDER BY e.starts_at, r.id
    `).all(timestamp, timestamp);
    for (const row of due) db.$client.query("UPDATE registrations SET reminded_at = ? WHERE id = ?").run(timestamp, row.id);
    return due.map((row) => ({ kind: "run_reminder", userId: row.user_id, eventId: row.event_id }));
  })();
});
