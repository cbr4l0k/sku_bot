import { Effect } from "effect";
import type { Db } from "@sku/db";
import { Database } from "../services";
import { SeriesRejected } from "./errors";
import { eventStats } from "./stats";
import { syncEventStaff } from "./staff";
import type { OfferEffect } from "./types";
import { issueOffersSync } from "./waitlist";

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
  reminders_enabled: number;
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

type SpawnError = Extract<SeriesRejected["code"], "series_not_found" | "series_inactive" | "next_starts_at_missing" | "next_starts_at_past">;

const seriesById = (db: Db, seriesId: number) => db.$client.query<SeriesRow, [number]>(`
  SELECT id, city, title, description, location, location_url, capacity,
    waitlist_enabled, reminders_enabled, home_chat_id, next_starts_at, cadence_days, active, created_by
  FROM event_series WHERE id = ?
`).get(seriesId);

/**
 * A spawn consumes the one date a human approved and leaves behind independent
 * inventory rows. Nothing in an old occurrence can therefore be rewritten by
 * editing the template for the next one.
 */
export const spawnOccurrence = Effect.fn("series.spawnOccurrence")(function* (seriesId: number, now: Date) {
  const db = yield* Database;
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
    const event = db.$client.query<{ id: number }, [string, string, string, number, string, string | null, number | null, number, number, number | null, number, number, number, number]>(`
      INSERT INTO events (
        city, title, description, starts_at, location, location_url, capacity,
        waitlist_enabled, reminders_enabled, status, home_chat_id, series_id, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?) RETURNING id
    `).get(
      series.city, series.title, series.description, startsAt,
      series.location, series.location_url, series.capacity, series.waitlist_enabled, series.reminders_enabled,
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
        event_id, name, description, price_minor, quota, active, sort_order, created_at, updated_at
      ) SELECT ?, name, description, price_minor, quota, active, sort_order, ?, ?
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

  if ("error" in result) return yield* new SeriesRejected({ code: result.error });
  // Staffing follows the committed copy rather than joining its transaction.
  yield* syncEventStaff(result.eventId, now);
  return result;
});

/** A date is due only after its review window has opened. */
export const dueSeries = Effect.fnUntraced(function* (now: Date): Effect.fn.Return<number[], never, Database> {
  const db = yield* Database;
  return db.$client
  .query<{ id: number }, [number, number]>(`
    SELECT id FROM event_series
    WHERE active = 1 AND next_starts_at IS NOT NULL
      AND next_starts_at - lead_days * ? <= ?
    ORDER BY next_starts_at, id
  `).all(DAY_SECONDS, seconds(now))
  .map((row) => row.id);
});

export const skipNext = Effect.fn("series.skipNext")(function* (seriesId: number, now: Date) {
  const db = yield* Database;
  const series = seriesById(db, seriesId);
  if (!series) return yield* new SeriesRejected({ code: "series_not_found" });
  if (series.next_starts_at === null) return yield* new SeriesRejected({ code: "next_starts_at_missing" });
  if (series.cadence_days === null) return yield* new SeriesRejected({ code: "cadence_missing" });
  db.$client.query("UPDATE event_series SET next_starts_at = ?, updated_at = ? WHERE id = ?")
    .run(series.next_starts_at + series.cadence_days * DAY_SECONDS, seconds(now), seriesId);
  return { ok: true as const };
});

/** Moving or clearing the next run is always allowed; the schedule belongs to people. */
export const setNextStartsAt = Effect.fn("series.setNextStartsAt")(function* (seriesId: number, date: Date | null, now: Date) {
  const db = yield* Database;
  const result = db.$client.query("UPDATE event_series SET next_starts_at = ?, updated_at = ? WHERE id = ?")
    .run(date === null ? null : seconds(date), seconds(now), seriesId);
  if (!result.changes) return yield* new SeriesRejected({ code: "series_not_found" });
  return { ok: true as const };
});

/**
 * The runs of a series still ahead of it: not started, not ended, not cancelled.
 * Who leads a series and whether it queues reach these as well as the template,
 * so the next sessions are run the way the series now says. A run that has
 * started keeps what it had — that night's roster is already the record.
 */
const followingEventIds = (db: Db, seriesId: number, now: Date): number[] => db.$client
  .query<{ id: number }, [number, number]>(`
    SELECT id FROM events
    WHERE series_id = ? AND starts_at > ? AND ended_at IS NULL AND status <> 'canceled'
    ORDER BY starts_at, id
  `)
  .all(seriesId, seconds(now))
  .map((row) => row.id);

export const unknownUserIds = (db: Db, userIds: readonly number[]): boolean => {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return false;
  const known = db.$client
    .query<{ count: number }, number[]>(`SELECT count(*) AS count FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .get(...ids)?.count ?? 0;
  return known !== ids.length;
};

/**
 * Names who leads the series and every run still ahead of it. Leads are the
 * only people put on a roster without signing up, so each of those runs is
 * re-staffed straight after: a new lead lands on it, a dropped one comes off
 * unless they have already checked in.
 */
export const setSeriesLeads = Effect.fn("series.setSeriesLeads")(function* (seriesId: number, userIds: readonly number[], now: Date) {
  const db = yield* Database;
  const ids = [...new Set(userIds)];
  const result = db.$client.transaction((): { eventIds: number[] } | { error: "series_not_found" | "user_not_found" } => {
    if (!seriesById(db, seriesId)) return { error: "series_not_found" };
    if (unknownUserIds(db, ids)) return { error: "user_not_found" };
    db.$client.query("DELETE FROM series_organizers WHERE series_id = ?").run(seriesId);
    for (const userId of ids) db.$client.query("INSERT INTO series_organizers (series_id, user_id) VALUES (?, ?)").run(seriesId, userId);
    const eventIds = followingEventIds(db, seriesId, now);
    for (const eventId of eventIds) {
      db.$client.query("DELETE FROM event_organizers WHERE event_id = ?").run(eventId);
      for (const userId of ids) db.$client.query("INSERT INTO event_organizers (event_id, user_id) VALUES (?, ?)").run(eventId, userId);
    }
    db.$client.query("UPDATE event_series SET updated_at = ? WHERE id = ?").run(seconds(now), seriesId);
    return { eventIds };
  })();
  if ("error" in result) return yield* new SeriesRejected({ code: result.error });
  for (const eventId of result.eventIds) yield* syncEventStaff(eventId, now);
  return { following: result.eventIds.length };
});

/**
 * Switches the queue for the series and every run still ahead of it, with the
 * same meaning as on a single event: off keeps anyone already queued in place,
 * dormant; on hands out whatever spots that dormant queue missed.
 */
export const setSeriesWaitlist = Effect.fn("series.setSeriesWaitlist")(function* (seriesId: number, enabled: boolean, now: Date) {
  const db = yield* Database;
  const result = db.$client.transaction((): { eventIds: number[]; effects: OfferEffect[] } | { error: "series_not_found" } => {
    if (!seriesById(db, seriesId)) return { error: "series_not_found" };
    const timestamp = seconds(now);
    db.$client.query("UPDATE event_series SET waitlist_enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, timestamp, seriesId);
    const eventIds = followingEventIds(db, seriesId, now);
    const effects: OfferEffect[] = [];
    for (const eventId of eventIds) {
      const changed = db.$client
        .query("UPDATE events SET waitlist_enabled = ?, updated_at = ? WHERE id = ? AND waitlist_enabled <> ?")
        .run(enabled ? 1 : 0, timestamp, eventId, enabled ? 1 : 0).changes;
      // Offers are written with the switch, so a failure leaves the queue as it was.
      if (changed && enabled) effects.push(...issueOffersSync(db, eventId, now));
    }
    return { eventIds, effects };
  })();
  if ("error" in result) return yield* new SeriesRejected({ code: result.error });
  return { following: result.eventIds.length, effects: result.effects };
});

export const attachEvent = Effect.fn("series.attachEvent")(function* (eventId: number, seriesId: number) {
  const db = yield* Database;
  const event = db.$client.query<{ city: string }, [number]>("SELECT city FROM events WHERE id = ?").get(eventId);
  if (!event) return yield* new SeriesRejected({ code: "event_not_found" });
  const series = seriesById(db, seriesId);
  if (!series) return yield* new SeriesRejected({ code: "series_not_found" });
  if (event.city !== series.city) return yield* new SeriesRejected({ code: "city_mismatch" });
  db.$client.query("UPDATE events SET series_id = ? WHERE id = ?").run(seriesId, eventId);
  return { ok: true as const };
});

export const detachEvent = Effect.fn("series.detachEvent")(function* (eventId: number) {
  const db = yield* Database;
  const result = db.$client.query("UPDATE events SET series_id = NULL WHERE id = ?").run(eventId);
  if (!result.changes) return yield* new SeriesRejected({ code: "event_not_found" });
  return { ok: true as const };
});

type OccurrenceRow = { id: number; title: string; starts_at: number; capacity: number | null; status: string; ended_at: number | null };
type ParticipantRow = { user_id: number; status: string; is_staff: number };

export const seriesStats = Effect.fn("series.seriesStats")(function* (seriesId: number) {
  const db = yield* Database;
  const rows = db.$client.query<OccurrenceRow, [number]>(`
    SELECT id, title, starts_at, capacity, status, ended_at FROM events
    WHERE series_id = ? ORDER BY starts_at, id
  `).all(seriesId);
  const confirmedByUser = new Map<number, number>();
  const checkedInByUser = new Map<number, number>();
  // Everyone who held a spot on any run, staff included, for the full list.
  const heldSpot = new Set<number>();
  const firstConfirmedAt = new Map(db.$client.query<{ user_id: number; starts_at: number }, [number]>(`
    SELECT r.user_id, min(e.starts_at) AS starts_at
    FROM registrations r JOIN events e ON e.id = r.event_id
    WHERE e.series_id = ? AND r.is_staff = 0
      AND r.status IN ('registered', 'checked_in')
    GROUP BY r.user_id
  `).all(seriesId).map((row) => [row.user_id, row.starts_at] as const));
  let revenueMinor = 0;

  const occurrences = yield* Effect.forEach(rows, Effect.fnUntraced(function* (event) {
    const counts = yield* eventStats(event.id);
    // Series analytics describe participants, never the people staffing the run;
    // staff rows are excluded from every participant count just as in stats.ts.
    // Regulars are the exception: they reward turning up, and an admin who
    // checked in turned up just like anyone else.
    const confirmed = db.$client.query<ParticipantRow, [number]>(`
      SELECT user_id, status, is_staff FROM registrations
      WHERE event_id = ? AND status IN ('registered', 'checked_in')
    `).all(event.id);
    for (const row of confirmed) {
      heldSpot.add(row.user_id);
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
      status: event.status,
      // Held: someone ran it and declared it over. Drafts, upcoming and canceled
      // runs stay in the list but are kept out of the held-only averages below.
      held: event.ended_at !== null && event.status !== "canceled",
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
  }));

  const people = new Map<number, { first_name: string; last_name: string | null; username: string | null }>();
  if (heldSpot.size) {
    const placeholders = [...heldSpot].map(() => "?").join(", ");
    const users = db.$client.query<{ id: number; first_name: string; last_name: string | null; username: string | null }, number[]>(
      `SELECT id, first_name, last_name, username FROM users WHERE id IN (${placeholders})`,
    ).all(...heldSpot);
    for (const user of users) people.set(user.id, user);
  }
  // Most turned up first. Someone who held a spot but never checked in is still
  // a participant, at the bottom with nothing attended.
  const participants = [...heldSpot]
    .map((userId) => {
      const person = people.get(userId);
      return {
        userId,
        firstName: person?.first_name ?? "",
        lastName: person?.last_name ?? null,
        username: person?.username ?? null,
        attended: checkedInByUser.get(userId) ?? 0,
      };
    })
    .sort((a, b) => b.attended - a.attended || a.userId - b.userId);
  const regulars = participants.filter((person) => person.attended > 0).slice(0, 10);
  const participationCounts = [...confirmedByUser.values()];
  const capacityOccurrences = occurrences.filter((occurrence) => occurrence.capacity !== null && occurrence.capacity > 0);
  const held = occurrences.filter((occurrence) => occurrence.held);
  const heldWithCapacity = held.filter((occurrence) => occurrence.capacity !== null && occurrence.capacity > 0);
  // First time: the series is where they first turned up at the club at all — no
  // check-in anywhere before their first date here. Everyone else was returning.
  const firstTime = db.$client.query<{ value: number }, [number]>(`
    SELECT count(*) AS value FROM (
      SELECT r.user_id, min(e.starts_at) AS starts_at
      FROM registrations r JOIN events e ON e.id = r.event_id
      WHERE e.series_id = ? AND r.is_staff = 0 AND r.status IN ('registered', 'checked_in')
      GROUP BY r.user_id
    ) f WHERE NOT EXISTS (
      SELECT 1 FROM registrations p JOIN events pe ON pe.id = p.event_id
      WHERE p.user_id = f.user_id AND p.status = 'checked_in' AND pe.starts_at < f.starts_at
    )
  `).get(seriesId)?.value ?? 0;

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
      held: held.length,
      turnout: held.length ? held.reduce((sum, occurrence) => sum + occurrence.attendanceRate, 0) / held.length : 0,
      fillRate: heldWithCapacity.length
        ? heldWithCapacity.reduce((sum, occurrence) => sum + occurrence.fillRate, 0) / heldWithCapacity.length
        : 0,
      firstTime,
      returning: confirmedByUser.size - firstTime,
    },
    // "N of M" reads attended of totals.held.
    regulars,
    participants,
    retention: {
      onceOnly: participationCounts.filter((count) => count === 1).length,
      twoToThree: participationCounts.filter((count) => count >= 2 && count <= 3).length,
      fourPlus: participationCounts.filter((count) => count >= 4).length,
    },
  };
});

/** Switches run reminders for the series and every run still ahead of it. */
export const setSeriesReminders = Effect.fn("series.setSeriesReminders")(function* (seriesId: number, enabled: boolean, now: Date) {
  const db = yield* Database;
  const result = db.$client.transaction((): { eventIds: number[] } | { error: "series_not_found" } => {
    if (!seriesById(db, seriesId)) return { error: "series_not_found" };
    const timestamp = seconds(now);
    db.$client.query("UPDATE event_series SET reminders_enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, timestamp, seriesId);
    const eventIds = followingEventIds(db, seriesId, now);
    for (const eventId of eventIds) db.$client.query("UPDATE events SET reminders_enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, timestamp, eventId);
    return { eventIds };
  })();
  if ("error" in result) return yield* new SeriesRejected({ code: result.error });
  return { following: result.eventIds.length };
});
