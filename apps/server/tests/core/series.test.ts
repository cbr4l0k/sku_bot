import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import {
  dueSeries,
  seriesStats,
  setNextStartsAt,
  skipNext,
  spawnOccurrence,
} from "../../src/core/series";

let db: Db;
const now = new Date("2030-01-01T12:00:00Z");
const unix = (date: Date) => Math.floor(date.getTime() / 1000);
const days = (count: number) => count * 24 * 60 * 60;

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  for (let id = 1; id <= 8; id++) {
    db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
  }
});

const createSeries = (nextStartsAt: Date | null, cadenceDays: number | null = 7) => {
  const row = db.$client.query<{ id: number }, [number | null, number | null]>(`
    INSERT INTO event_series (
      city, title, description, location, capacity, next_starts_at,
      cadence_days, created_by
    ) VALUES ('spb', 'Track night', 'Intervals', 'Stadium', 20, ?, ?, 1)
    RETURNING id
  `).get(nextStartsAt === null ? null : unix(nextStartsAt), cadenceDays);
  if (!row) throw new Error("Series insert returned no id");
  return row.id;
};

const eventDates = (seriesId: number) => db.$client
  .query<{ starts_at: number }, [number]>("SELECT starts_at FROM events WHERE series_id = ? ORDER BY starts_at, id")
  .all(seriesId)
  .map((row) => row.starts_at);

describe("series spawning", () => {
  test("copies the complete template into independent rows on a fresh draft", () => {
    const startsAt = new Date("2030-01-10T19:30:00Z");
    const seriesId = createSeries(startsAt);
    db.$client.query("INSERT INTO series_chats (series_id, chat_id) VALUES (?, 99)").run(seriesId);
    db.$client.query("INSERT INTO series_organizers (series_id, user_id) VALUES (?, 2)").run(seriesId);
    db.$client.query("INSERT INTO series_ticket_tiers (series_id, name, price_minor, quota, sort_order) VALUES (?, 'Runner', 150000, 12, 3)").run(seriesId);
    const product = db.$client.query<{ id: number }, [number]>(`
      INSERT INTO series_products (
        series_id, kind, name, description, price_minor, stock, max_per_order, sort_order
      ) VALUES (?, 'merchandise', 'Club tee', 'Blue', 250000, NULL, 2, 4) RETURNING id
    `).get(seriesId);
    if (!product) throw new Error("Product insert returned no id");
    db.$client.query("INSERT INTO series_product_variants (product_id, name, stock, sort_order) VALUES (?, 'M', 8, 5)").run(product.id);

    const result = spawnOccurrence(db, seriesId, now);
    expect("eventId" in result).toBe(true);
    if (!("eventId" in result)) return;
    const event = db.$client.query<{ status: string; starts_at: number; series_id: number }, [number]>(
      "SELECT status, starts_at, series_id FROM events WHERE id = ?",
    ).get(result.eventId);
    expect(event).toEqual({ status: "draft", starts_at: unix(startsAt), series_id: seriesId });
    expect(db.$client.query("SELECT chat_id FROM event_chats WHERE event_id = ?").all(result.eventId)).toEqual([{ chat_id: 99 }]);
    expect(db.$client.query("SELECT user_id FROM event_organizers WHERE event_id = ?").all(result.eventId)).toEqual([{ user_id: 2 }]);
    expect(db.$client.query("SELECT name, price_minor, quota, sort_order, sales_start_at, sales_end_at FROM ticket_tiers WHERE event_id = ?").all(result.eventId))
      .toEqual([{ name: "Runner", price_minor: 150000, quota: 12, sort_order: 3, sales_start_at: null, sales_end_at: null }]);
    const copiedProduct = db.$client.query<{ id: number; name: string; stock: number | null; sort_order: number }, [number]>(
      "SELECT id, name, stock, sort_order FROM event_products WHERE event_id = ?",
    ).get(result.eventId);
    expect(copiedProduct).toMatchObject({ name: "Club tee", stock: null, sort_order: 4 });
    expect(db.$client.query("SELECT name, stock, sort_order FROM event_product_variants WHERE product_id = ?").all(copiedProduct?.id ?? 0))
      .toEqual([{ name: "M", stock: 8, sort_order: 5 }]);
  });

  test("always creates a draft even when the approved date is already in the past", () => {
    const seriesId = createSeries(new Date("2029-12-01T09:00:00Z"));
    const result = spawnOccurrence(db, seriesId, now);
    if (!("eventId" in result)) throw new Error(result.error);
    expect(db.$client.query<{ status: string }, [number]>("SELECT status FROM events WHERE id = ?").get(result.eventId)?.status).toBe("draft");
  });

  test("advances by the cadence hint and clears a hand-scheduled date", () => {
    const firstDate = new Date("2030-01-10T19:30:00Z");
    const weekly = createSeries(firstDate, 7);
    spawnOccurrence(db, weekly, now);
    expect(db.$client.query<{ next_starts_at: number | null }, [number]>("SELECT next_starts_at FROM event_series WHERE id = ?").get(weekly)?.next_starts_at)
      .toBe(unix(firstDate) + days(7));

    const handScheduled = createSeries(firstDate, null);
    spawnOccurrence(db, handScheduled, now);
    expect(db.$client.query<{ next_starts_at: number | null }, [number]>("SELECT next_starts_at FROM event_series WHERE id = ?").get(handScheduled)?.next_starts_at)
      .toBeNull();
  });

  test("two immediate spawns cannot create the same occurrence date twice", () => {
    const firstDate = new Date("2030-01-10T19:30:00Z");
    const seriesId = createSeries(firstDate, 7);
    spawnOccurrence(db, seriesId, now);
    spawnOccurrence(db, seriesId, now);
    expect(eventDates(seriesId)).toEqual([unix(firstDate), unix(firstDate) + days(7)]);
    expect(new Set(eventDates(seriesId)).size).toBe(2);
  });

  test("an irregular Sunday-to-Wednesday series follows the dates a human chose", () => {
    const sunday = new Date("2030-01-06T09:30:00Z");
    const wednesday = new Date("2030-01-09T19:00:00Z");
    const seriesId = createSeries(null, null);
    expect(setNextStartsAt(db, seriesId, sunday, now)).toEqual({ ok: true });
    spawnOccurrence(db, seriesId, now);
    expect(setNextStartsAt(db, seriesId, wednesday, now)).toEqual({ ok: true });
    spawnOccurrence(db, seriesId, now);
    expect(eventDates(seriesId)).toEqual([unix(sunday), unix(wednesday)]);
  });

  test("a series left stale rolls past the dates nobody ran instead of inventing them", () => {
    // The club was down for a month. The five Tuesdays that went by unattended
    // must not reappear as drafts: they would sit in the occurrence list forever
    // with no registrations and pull every average in seriesStats to zero.
    const stale = new Date("2030-01-01T19:30:00Z");
    const seriesId = createSeries(stale, 7);
    const backUp = new Date("2030-01-31T12:00:00Z");
    for (const id of dueSeries(db, backUp)) spawnOccurrence(db, id, backUp);
    for (const id of dueSeries(db, backUp)) spawnOccurrence(db, id, backUp);
    expect(eventDates(seriesId)).toEqual([
      unix(new Date("2030-02-05T19:30:00Z")),
      unix(new Date("2030-02-12T19:30:00Z")),
    ]);
  });

  test("a hand-scheduled series whose date passed stops asking rather than guessing", () => {
    const seriesId = createSeries(new Date("2030-01-01T09:30:00Z"), null);
    const later = new Date("2030-01-20T12:00:00Z");
    expect(spawnOccurrence(db, seriesId, later)).toEqual({ error: "next_starts_at_past" });
    expect(eventDates(seriesId)).toEqual([]);
  });

  test("skip advances the proposal without creating an event", () => {
    const firstDate = new Date("2030-01-10T19:30:00Z");
    const seriesId = createSeries(firstDate, 7);
    expect(skipNext(db, seriesId, now)).toEqual({ ok: true });
    expect(eventDates(seriesId)).toEqual([]);
    expect(db.$client.query<{ next_starts_at: number }, [number]>("SELECT next_starts_at FROM event_series WHERE id = ?").get(seriesId)?.next_starts_at)
      .toBe(unix(firstDate) + days(7));
  });

  test("due dates honor the per-series lead window", () => {
    const due = createSeries(new Date(now.getTime() + days(14) * 1000));
    createSeries(new Date(now.getTime() + days(15) * 1000));
    expect(dueSeries(db, now)).toEqual([due]);
  });

  test("deleting a series preserves its occurrences and registrations", () => {
    const seriesId = createSeries(new Date("2030-01-10T19:30:00Z"), null);
    const result = spawnOccurrence(db, seriesId, now);
    if (!("eventId" in result)) throw new Error(result.error);
    db.$client.query("INSERT INTO registrations (event_id, user_id, status) VALUES (?, 3, 'registered')").run(result.eventId);
    db.$client.query("DELETE FROM event_series WHERE id = ?").run(seriesId);
    expect(db.$client.query<{ series_id: number | null }, [number]>("SELECT series_id FROM events WHERE id = ?").get(result.eventId)?.series_id).toBeNull();
    expect(db.$client.query<{ count: number }, [number]>("SELECT count(*) AS count FROM registrations WHERE event_id = ?").get(result.eventId)?.count).toBe(1);
  });
});

test("series stats distinguish newcomers, returning runners, retention and settled revenue", () => {
  const seriesId = createSeries(null, null);
  const eventIds = [0, 1, 2].map((offset) => {
    const row = db.$client.query<{ id: number }, [number, number]>(`
      INSERT INTO events (
        city, title, description, starts_at, location, capacity, status, series_id, created_by
      ) VALUES ('spb', 'Track night', 'Intervals', ?, 'Stadium', 4, 'published', ?, 1)
      RETURNING id
    `).get(unix(new Date("2030-02-01T10:00:00Z")) + days(offset * 7), seriesId);
    if (!row) throw new Error("Event insert returned no id");
    return row.id;
  });
  const add = (eventId: number, userId: number, status: "registered" | "waitlisted" | "checked_in", isStaff = 0) => {
    db.$client.query("INSERT INTO registrations (event_id, user_id, status, is_staff) VALUES (?, ?, ?, ?)")
      .run(eventId, userId, status, isStaff);
  };
  add(eventIds[0]!, 1, "checked_in", 1);
  add(eventIds[0]!, 2, "checked_in");
  add(eventIds[0]!, 3, "registered");
  add(eventIds[0]!, 6, "waitlisted");
  add(eventIds[1]!, 1, "checked_in", 1);
  add(eventIds[1]!, 2, "checked_in");
  add(eventIds[1]!, 4, "checked_in");
  add(eventIds[2]!, 1, "checked_in", 1);
  add(eventIds[2]!, 2, "registered");
  add(eventIds[2]!, 3, "checked_in");
  add(eventIds[2]!, 5, "registered");

  const order = (id: string, eventId: number, status: "payment_succeeded" | "fulfilled" | "refunded", unit: number, quantity: number) => {
    db.$client.query(`
      INSERT INTO ticket_orders (id, event_id, user_id, amount_minor, status, expires_at)
      VALUES (?, ?, 2, ?, ?, ?)
    `).run(id, eventId, unit * quantity, status, unix(now));
    db.$client.query(`
      INSERT INTO order_items (order_id, kind, name, unit_amount_minor, quantity)
      VALUES (?, 'addon', 'Photo', ?, ?)
    `).run(id, unit, quantity);
  };
  order("paid", eventIds[0]!, "payment_succeeded", 100, 2);
  order("fulfilled", eventIds[1]!, "fulfilled", 300, 1);
  order("refunded", eventIds[2]!, "refunded", 900, 1);

  const stats = seriesStats(db, seriesId);
  expect(stats.occurrences.map(({ newcomers, returning, registered, waitlisted }) => ({ newcomers, returning, registered, waitlisted }))).toEqual([
    { newcomers: 2, returning: 0, registered: 2, waitlisted: 1 },
    { newcomers: 1, returning: 1, registered: 2, waitlisted: 0 },
    { newcomers: 1, returning: 2, registered: 3, waitlisted: 0 },
  ]);
  expect(stats.totals).toMatchObject({ occurrences: 3, uniqueParticipants: 4, revenueMinor: 500 });
  expect(stats.regulars).toEqual([
    { userId: 2, firstName: "U2", attended: 2 },
    { userId: 3, firstName: "U3", attended: 1 },
    { userId: 4, firstName: "U4", attended: 1 },
  ]);
  expect(stats.retention).toEqual({ onceOnly: 2, twoToThree: 2, fourPlus: 0 });
});
