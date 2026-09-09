import type { CitySlug } from "@sku/cities";
import type { Db } from "@sku/db";

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * Everyone who belongs on an event by right of the job rather than by signing
 * up: the club's own admins, the admins of the branch the event runs in, and
 * anyone named on the event itself.
 *
 * A branch *organizer* is deliberately not here. An organizer may raise runs in
 * their city but can only manage the ones they are named on (see
 * `canManageEvent`), so being named is what puts them on a roster — matching
 * exactly who the event screen lets in.
 *
 * Banned users are excluded: a revoked account should not reappear on rosters
 * because an old role row outlived it.
 */
export const staffUserIds = (db: Db, eventId: number): number[] => db.$client
  .query<{ user_id: number }, [number, number]>(`
    SELECT u.id AS user_id FROM users u
    WHERE u.is_banned = 0
      AND (
        u.is_admin = 1
        OR EXISTS (
          SELECT 1 FROM user_city_roles r
          JOIN events e ON e.id = ?
          WHERE r.user_id = u.id AND r.city = e.city AND r.role = 'admin'
        )
        OR EXISTS (SELECT 1 FROM event_organizers o WHERE o.event_id = ? AND o.user_id = u.id)
      )
    ORDER BY u.id
  `)
  .all(eventId, eventId)
  .map((row) => row.user_id);

/** Only events where checking in could still happen are worth staffing. */
const liveEvent = (db: Db, eventId: number) => db.$client
  .query<{ id: number }, [number]>("SELECT id FROM events WHERE id = ? AND ended_at IS NULL AND status <> 'canceled'")
  .get(eventId);

/**
 * Reconciles one event's staff rows against who the staff currently are.
 *
 * Inserting never disturbs an existing row: someone who signed up as an
 * ordinary participant keeps the spot they took, and someone who took
 * themselves off an event stays off it.
 *
 * Removing is narrower still. A staff row is withdrawn only while it is
 * untouched — still `registered`, never checked in — so demoting someone or
 * dropping them from an event clears them off future rosters, but anyone who
 * actually turned up stays on the record of the night.
 */
export const syncEventStaff = (db: Db, eventId: number, now: Date): { added: number; removed: number } =>
  db.$client.transaction((): { added: number; removed: number } => {
    if (!liveEvent(db, eventId)) return { added: 0, removed: 0 };
    const staff = staffUserIds(db, eventId);
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

    const keep = staff.length ? `AND user_id NOT IN (${staff.map(() => "?").join(", ")})` : "";
    const removed = db.$client
      .query(`
        DELETE FROM registrations
        WHERE event_id = ? AND is_staff = 1 AND status = 'registered' AND checked_in_at IS NULL ${keep}
      `)
      .run(eventId, ...staff).changes;

    return { added, removed };
  })();

const liveEventIds = (db: Db, city: CitySlug | null): number[] => (city === null
  ? db.$client.query<{ id: number }, []>("SELECT id FROM events WHERE ended_at IS NULL AND status <> 'canceled'").all()
  : db.$client
    .query<{ id: number }, [string]>("SELECT id FROM events WHERE city = ? AND ended_at IS NULL AND status <> 'canceled'")
    .all(city)
).map((row) => row.id);

/** After a branch role changes: every run of that branch that has not happened yet. */
export const syncCityStaff = (db: Db, city: CitySlug, now: Date): void => {
  for (const eventId of liveEventIds(db, city)) syncEventStaff(db, eventId, now);
};

/**
 * After a club-wide change — a promotion, or a boot that brought new ADMIN_IDS
 * with it. Cheap enough to run at startup: it touches only events that are
 * still to come, and does nothing at all once the rows are in place.
 */
export const syncAllStaff = (db: Db, now: Date): void => {
  for (const eventId of liveEventIds(db, null)) syncEventStaff(db, eventId, now);
};
