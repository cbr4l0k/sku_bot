import type { Db } from "@sku/db";
import { eventStats } from "./stats";
import { syncEventStaff } from "./staff";

const DAY_SECONDS = 24 * 60 * 60;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

type SeriesRow = {
  id: number;
  city: string;
  title: string;
  description: string;
  location: string;
  location_url: string | null;
  capacity: number | null;
  waitlist_enabled: number;
  home_chat_id: number | null;
  next_starts_at: number | null;
  cadence_days: number | null;
  active: number;
  created_by: number;
};

type ProductRow = {
  id: number;
  kind: string;
  name: string;
  description: string | null;
  price_minor: number;
  stock: number | null;
  max_per_order: number;
  active: number;
  sort_order: number;
};

type VariantRow = {
  product_id: number;
  name: string;
  stock: number | null;
  active: number;
  sort_order: number;
};

type SpawnError = "series_not_found" | "series_inactive" | "next_starts_at_missing" | "next_starts_at_past";

const seriesById = (db: Db, seriesId: number) => db.$client.query<SeriesRow, [number]>(`
  SELECT id, city, title, description, location, location_url, capacity,
    waitlist_enabled, home_chat_id, next_starts_at, cadence_days, active, created_by
  FROM event_series WHERE id = ?
`).get(seriesId);

/**
 * A spawn consumes the one date a human approved and leaves behind independent
 * inventory rows. Nothing in an old occurrence can therefore be rewritten by
 * editing the template for the next one.
 */
export const spawnOccurrence = (db: Db, seriesId: number, now: Date): { eventId: number } | { error: SpawnError } => {
  const result = db.$client.transaction((): { eventId: number } | { error: SpawnError } => {
    const series = seriesById(db, seriesId);
    if (!series) return { error: "series_not_found" };
    if (!series.active) return { error: "series_inactive" };
    if (series.next_starts_at === null) return { error: "next_starts_at_missing" };

    const timestamp = seconds(now);
    // A date that has already passed is never materialised. Nothing generated it
    // at the time — the club was down, or the series sat untouched — and a run
    // nobody could attend is worse than absent: it would join the occurrence list
    // as a phantom with no registrations and drag every average in seriesStats
    // toward zero. A cadence lets the schedule heal itself by rolling forward to
    // the next date that is still ahead; without one, only a person can say when
    // the next one is, so the series simply stops asking.
    let startsAt = series.next_starts_at;
    if (startsAt <= timestamp) {
      if (series.cadence_days === null || series.cadence_days <= 0) return { error: "next_starts_at_past" };
      const stride = series.cadence_days * DAY_SECONDS;
      startsAt += Math.ceil((timestamp - startsAt + 1) / stride) * stride;
    }
    // Publishing has effects far beyond this transaction — notifications and chat
    // invitations — so every generated run waits in draft for a person to inspect it.
    const event = db.$client.query<{ id: number }, [string, string, string, number, string, string | null, number | null, number, number | null, number, number, number, number]>(`
      INSERT INTO events (
        city, title, description, starts_at, location, location_url, capacity,
        waitlist_enabled, status, home_chat_id, series_id, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?) RETURNING id
    `).get(
      series.city, series.title, series.description, startsAt,
      series.location, series.location_url, series.capacity, series.waitlist_enabled,
      series.home_chat_id, series.id, series.created_by, timestamp, timestamp,
    );
    if (!event) throw new Error("Occurrence insert returned no id");

    db.$client.query(`
      INSERT INTO event_chats (event_id, chat_id)
      SELECT ?, chat_id FROM series_chats WHERE series_id = ?
    `).run(event.id, series.id);
    db.$client.query(`
      INSERT INTO event_organizers (event_id, user_id)
      SELECT ?, user_id FROM series_organizers WHERE series_id = ?
    `).run(event.id, series.id);
    db.$client.query(`
      INSERT INTO ticket_tiers (
        event_id, name, price_minor, quota, active, sort_order, created_at, updated_at
      ) SELECT ?, name, price_minor, quota, active, sort_order, ?, ?
        FROM series_ticket_tiers WHERE series_id = ? ORDER BY sort_order, id
    `).run(event.id, timestamp, timestamp, series.id);

    const products = db.$client.query<ProductRow, [number]>(`
      SELECT id, kind, name, description, price_minor, stock, max_per_order, active, sort_order
      FROM series_products WHERE series_id = ? ORDER BY sort_order, id
    `).all(series.id);
    const productIds = new Map<number, number>();
    for (const product of products) {
      const copied = db.$client.query<{ id: number }, [number, string, string, string | null, number, number | null, number, number, number, number, number]>(`
        INSERT INTO event_products (
          event_id, kind, name, description, price_minor, stock, max_per_order,
          active, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
      `).get(event.id, product.kind, product.name, product.description, product.price_minor,
        product.stock, product.max_per_order, product.active, product.sort_order, timestamp, timestamp);
      if (!copied) throw new Error("Occurrence product insert returned no id");
      productIds.set(product.id, copied.id);
    }

    const variants = db.$client.query<VariantRow, [number]>(`
      SELECT v.product_id, v.name, v.stock, v.active, v.sort_order
      FROM series_product_variants v
      JOIN series_products p ON p.id = v.product_id
      WHERE p.series_id = ? ORDER BY p.sort_order, p.id, v.sort_order, v.id
    `).all(series.id);
    for (const variant of variants) {
      const productId = productIds.get(variant.product_id);
      if (productId === undefined) throw new Error("Series variant has no template product");
      db.$client.query(`
        INSERT INTO event_product_variants (
          product_id, name, stock, active, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(productId, variant.name, variant.stock, variant.active, variant.sort_order, timestamp, timestamp);
    }

    const proposed = series.cadence_days === null
      ? null
      : startsAt + series.cadence_days * DAY_SECONDS;
    // Consuming the trigger beside the inserts is the idempotency boundary: a
    // competing pass cannot observe this occurrence's approved date afterwards.
    db.$client.query("UPDATE event_series SET next_starts_at = ?, updated_at = ? WHERE id = ?")
      .run(proposed, timestamp, series.id);
    return { eventId: event.id };
  })();

  if ("eventId" in result) syncEventStaff(db, result.eventId, now);
  return result;
};

/** A date is due only after its review window has opened. */
export const dueSeries = (db: Db, now: Date): number[] => db.$client
  .query<{ id: number }, [number, number]>(`
    SELECT id FROM event_series
    WHERE active = 1 AND next_starts_at IS NOT NULL
      AND next_starts_at - lead_days * ? <= ?
    ORDER BY next_starts_at, id
  `).all(DAY_SECONDS, seconds(now))
  .map((row) => row.id);

export const skipNext = (db: Db, seriesId: number, now: Date): { ok: true } | { error: "series_not_found" | "next_starts_at_missing" | "cadence_missing" } => {
  const series = seriesById(db, seriesId);
  if (!series) return { error: "series_not_found" };
  if (series.next_starts_at === null) return { error: "next_starts_at_missing" };
  if (series.cadence_days === null) return { error: "cadence_missing" };
  db.$client.query("UPDATE event_series SET next_starts_at = ?, updated_at = ? WHERE id = ?")
    .run(series.next_starts_at + series.cadence_days * DAY_SECONDS, seconds(now), seriesId);
  return { ok: true };
};

/** Moving or clearing the next run is always allowed; the schedule belongs to people. */
export const setNextStartsAt = (db: Db, seriesId: number, date: Date | null, now: Date): { ok: true } | { error: "series_not_found" } => {
  const result = db.$client.query("UPDATE event_series SET next_starts_at = ?, updated_at = ? WHERE id = ?")
    .run(date === null ? null : seconds(date), seconds(now), seriesId);
  return result.changes ? { ok: true } : { error: "series_not_found" };
};

export const attachEvent = (db: Db, eventId: number, seriesId: number): { ok: true } | { error: "event_not_found" | "series_not_found" | "city_mismatch" } => {
  const event = db.$client.query<{ city: string }, [number]>("SELECT city FROM events WHERE id = ?").get(eventId);
  if (!event) return { error: "event_not_found" };
  const series = seriesById(db, seriesId);
  if (!series) return { error: "series_not_found" };
  if (event.city !== series.city) return { error: "city_mismatch" };
  db.$client.query("UPDATE events SET series_id = ? WHERE id = ?").run(seriesId, eventId);
  return { ok: true };
};

export const detachEvent = (db: Db, eventId: number): { ok: true } | { error: "event_not_found" } => {
  const result = db.$client.query("UPDATE events SET series_id = NULL WHERE id = ?").run(eventId);
  return result.changes ? { ok: true } : { error: "event_not_found" };
};

type OccurrenceRow = { id: number; title: string; starts_at: number; capacity: number | null };
type ParticipantRow = { user_id: number; status: string; is_staff: number };

export const seriesStats = (db: Db, seriesId: number) => {
  const rows = db.$client.query<OccurrenceRow, [number]>(`
    SELECT id, title, starts_at, capacity FROM events
    WHERE series_id = ? ORDER BY starts_at, id
  `).all(seriesId);
  const confirmedByUser = new Map<number, number>();
  const checkedInByUser = new Map<number, number>();
  const names = new Map<number, string>();
  const firstConfirmedAt = new Map(db.$client.query<{ user_id: number; starts_at: number }, [number]>(`
    SELECT r.user_id, min(e.starts_at) AS starts_at
    FROM registrations r JOIN events e ON e.id = r.event_id
    WHERE e.series_id = ? AND r.is_staff = 0
      AND r.status IN ('registered', 'checked_in')
    GROUP BY r.user_id
  `).all(seriesId).map((row) => [row.user_id, row.starts_at] as const));
  let revenueMinor = 0;

  const occurrences = rows.map((event) => {
    const counts = eventStats(db, event.id);
    // Series analytics describe participants, never the people staffing the run;
    // staff rows are excluded from every participant count just as in stats.ts.
    // Regulars are the exception: they reward turning up, and an admin who
    // checked in turned up just like anyone else.
    const confirmed = db.$client.query<ParticipantRow, [number]>(`
      SELECT user_id, status, is_staff FROM registrations
      WHERE event_id = ? AND status IN ('registered', 'checked_in')
    `).all(event.id);
    for (const row of confirmed) {
      if (row.status === "checked_in") checkedInByUser.set(row.user_id, (checkedInByUser.get(row.user_id) ?? 0) + 1);
    }
    const participants = confirmed.filter((row) => row.is_staff === 0);
    let newcomers = 0;
    let returning = 0;
    for (const participant of participants) {
      // Equal-time occurrences are not earlier than each other; the first date,
      // rather than whichever row happens to sort first, decides newcomer status.
      if (firstConfirmedAt.get(participant.user_id) === event.starts_at) newcomers++;
      else returning++;
      confirmedByUser.set(participant.user_id, (confirmedByUser.get(participant.user_id) ?? 0) + 1);
    }
    const settled = db.$client.query<{ value: number | null }, [number]>(`
      SELECT sum(i.unit_amount_minor * i.quantity) AS value
      FROM ticket_orders o JOIN order_items i ON i.order_id = o.id
      WHERE o.event_id = ? AND o.status IN ('payment_succeeded', 'fulfilled')
    `).get(event.id)?.value ?? 0;
    revenueMinor += settled;
    return {
      eventId: event.id,
      title: event.title,
      startsAt: new Date(event.starts_at * 1000),
      capacity: event.capacity,
      registered: counts.registered,
      waitlisted: counts.waitlisted,
      checkedIn: counts.checkedIn,
      attendanceRate: counts.attendanceRate,
      fillRate: event.capacity !== null && event.capacity > 0 ? counts.registered / event.capacity : 0,
      newcomers,
      returning,
      revenueMinor: settled,
    };
  });

  if (checkedInByUser.size) {
    const placeholders = [...checkedInByUser].map(() => "?").join(", ");
    const users = db.$client.query<{ id: number; first_name: string }, number[]>(
      `SELECT id, first_name FROM users WHERE id IN (${placeholders})`,
    ).all(...checkedInByUser.keys());
    for (const user of users) names.set(user.id, user.first_name);
  }
  const regulars = [...checkedInByUser.entries()]
    .map(([userId, attended]) => ({ userId, firstName: names.get(userId) ?? "", attended }))
    .sort((a, b) => b.attended - a.attended || a.userId - b.userId)
    .slice(0, 10);
  const participationCounts = [...confirmedByUser.values()];
  const capacityOccurrences = occurrences.filter((occurrence) => occurrence.capacity !== null && occurrence.capacity > 0);

  return {
    occurrences,
    totals: {
      occurrences: occurrences.length,
      uniqueParticipants: confirmedByUser.size,
      avgAttendanceRate: occurrences.length
        ? occurrences.reduce((sum, occurrence) => sum + occurrence.attendanceRate, 0) / occurrences.length
        : 0,
      avgFillRate: capacityOccurrences.length
        ? capacityOccurrences.reduce((sum, occurrence) => sum + occurrence.fillRate, 0) / capacityOccurrences.length
        : 0,
      revenueMinor,
    },
    regulars,
    retention: {
      onceOnly: participationCounts.filter((count) => count === 1).length,
      twoToThree: participationCounts.filter((count) => count >= 2 && count <= 3).length,
      fourPlus: participationCounts.filter((count) => count >= 4).length,
    },
  };
};
