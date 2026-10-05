import { Effect } from "effect";
import type { Db } from "@sku/db";
import { Database } from "../services";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * Everyone who belongs on an event by right of the job rather than by signing
 * up: the people named as leading it (its "led by"), and nobody else. Being an
 * admin, of the club or of the branch, grants the power to run any event but no
 * place on its roster — an admin who wants to come along signs up like anyone
 * else and takes a spot like anyone else.
 *
 * Banned users are excluded: a revoked account should not reappear on rosters
 * because an old assignment outlived it.
 */
const staffOf = (db: Db, eventId: number): number[] => db.$client
  .query<{ user_id: number }, [number]>(`
    SELECT o.user_id FROM event_organizers o
    JOIN users u ON u.id = o.user_id
    WHERE o.event_id = ? AND u.is_banned = 0
    ORDER BY o.user_id
  `)
  .all(eventId)
  .map((row) => row.user_id);

export const staffUserIds = Effect.fnUntraced(function* (eventId: number) {
  return staffOf(yield* Database, eventId);
});

/** Only events where checking in could still happen are worth staffing. */
const liveEvent = (db: Db, eventId: number) => db.$client
  .query<{ id: number }, [number]>("SELECT id FROM events WHERE id = ? AND ended_at IS NULL AND status <> 'canceled'")
  .get(eventId);

/**
 * Reconciles one event's staff rows against who the staff currently are.
 *
 * Inserting never disturbs an existing row: someone who signed up as an
 * ordinary participant keeps the spot they took, and someone who took
 * themselves off an event stays off it. The one exception is a lead still
 * waiting in the queue, who joins the roster as staff.
 *
 * Removing is narrower still. A staff row is withdrawn only while it is
 * untouched — still `registered`, never checked in — so demoting someone or
 * dropping them from an event clears them off future rosters, but anyone who
 * actually turned up stays on the record of the night.
 *
 * A cancelled row of someone no longer leading loses its staff flag instead, so
 * that if they sign up again they come back as a participant who takes a spot.
 */
const syncEventStaffIn = (db: Db, eventId: number, now: Date): { added: number; removed: number } =>
  db.$client.transaction((): { added: number; removed: number } => {
    if (!liveEvent(db, eventId)) return { added: 0, removed: 0 };
    const staff = staffOf(db, eventId);
    const timestamp = seconds(now);

    let added = 0;
    for (const userId of staff) {
      const result = db.$client
        .query(`
          INSERT INTO registrations (event_id, user_id, status, is_staff, created_at, updated_at)
          VALUES (?, ?, 'registered', 1, ?, ?)
          ON CONFLICT (event_id, user_id) DO NOTHING
        `)
        .run(eventId, userId, timestamp, timestamp);
      added += result.changes;
    }

    // A lead stuck in their own run's queue is put on the roster as staff, and
    // any offer they held is withdrawn, since they no longer need the spot.
    const leads = staff.length ? `AND user_id IN (${staff.map(() => "?").join(", ")})` : "AND 0";
    db.$client
      .query(`UPDATE waitlist_offers SET status = 'superseded' WHERE event_id = ? AND status = 'pending' ${leads}`)
      .run(eventId, ...staff);
    added += db.$client
      .query(`UPDATE registrations SET status = 'registered', is_staff = 1, updated_at = ? WHERE event_id = ? AND status = 'waitlisted' ${leads}`)
      .run(timestamp, eventId, ...staff).changes;

    const keep = staff.length ? `AND user_id NOT IN (${staff.map(() => "?").join(", ")})` : "";
    const removed = db.$client
      .query(`
        DELETE FROM registrations
        WHERE event_id = ? AND is_staff = 1 AND status = 'registered' AND checked_in_at IS NULL ${keep}
      `)
      .run(eventId, ...staff).changes;
    db.$client
      .query(`UPDATE registrations SET is_staff = 0 WHERE event_id = ? AND is_staff = 1 AND status = 'canceled' ${keep}`)
      .run(eventId, ...staff);

    return { added, removed };
  })();

export const syncEventStaff = Effect.fn("staff.syncEventStaff")(function* (eventId: number, now: Date) {
  return syncEventStaffIn(yield* Database, eventId, now);
});

const liveEventIds = (db: Db): number[] => db.$client
  .query<{ id: number }, []>("SELECT id FROM events WHERE ended_at IS NULL AND status <> 'canceled'")
  .all()
  .map((row) => row.id);

/**
 * After a club-wide change — a ban, or a boot that may bring rosters from before
 * a rule change into line. Cheap enough to run at startup: it touches only events
 * that are still to come, and does nothing at all once the rows are in place.
 */
export const syncAllStaff = Effect.fn("staff.syncAllStaff")(function* (now: Date) {
  const db = yield* Database;
  for (const eventId of liveEventIds(db)) syncEventStaffIn(db, eventId, now);
});
