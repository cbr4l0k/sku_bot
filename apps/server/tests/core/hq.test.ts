import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import type { Actor } from "../../src/core/cities";
import { checkIn, manualToggleCheckin, scanTicket } from "../../src/core/checkin";
import { eventPhase, eventSummary, hqOverview, rosterFlags, seriesSummary } from "../../src/core/hq";
import { seriesStats } from "../../src/core/series";
import { run } from "../support/effect";

let db: Db;
const now = new Date("2030-01-10T12:00:00Z");
const unix = (date: Date) => Math.floor(date.getTime() / 1000);
const HOUR = 3600;
const admin: Actor = { userId: 1, isGlobalAdmin: true, roles: new Map() };

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  for (let id = 1; id <= 8; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
});

type EventInput = { startsIn: number; status?: string; endedAgo?: number; capacity?: number; seriesId?: number | null; city?: string };
const event = ({ startsIn, status = "published", endedAgo, capacity = 10, seriesId = null, city = "spb" }: EventInput) =>
  db.$client.query<{ id: number }, [string, number, number, string, number | null, number | null]>(`
    INSERT INTO events (city, title, description, starts_at, location, capacity, status, ended_at, series_id, created_by)
    VALUES (?, 'run', 'x', ?, 'park', ?, ?, ?, ?, 1) RETURNING id
  `).get(city, unix(now) + startsIn, capacity, status, endedAgo === undefined ? null : unix(now) - endedAgo, seriesId)!.id;

const register = (eventId: number, userId: number, status = "registered", isStaff = 0) =>
  db.$client.query("INSERT INTO registrations (event_id, user_id, status, is_staff) VALUES (?, ?, ?, ?)").run(eventId, userId, status, isStaff);

const order = (id: string, eventId: number, userId: number, status: string, items: { kind: string; name: string; variant?: string; unit: number; handed?: boolean }[]) => {
  db.$client.query("INSERT INTO ticket_orders (id, event_id, user_id, amount_minor, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, eventId, userId, items.reduce((sum, item) => sum + item.unit, 0), status, unix(now));
  for (const item of items) {
    db.$client.query("INSERT INTO order_items (order_id, kind, name, variant_name, unit_amount_minor, quantity, handed_over_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run(id, item.kind, item.name, item.variant ?? null, item.unit, item.handed ? unix(now) : null);
  }
};

const createSeries = (active = 1, nextStartsAt: number | null = null) => db.$client.query<{ id: number }, [number, number | null]>(`
  INSERT INTO event_series (city, title, description, location, capacity, active, next_starts_at, lead_days, created_by)
  VALUES ('spb', 'Saturday long', 'x', 'park', 10, ?, ?, 5, 1) RETURNING id
`).get(active, nextStartsAt)!.id;

describe("event phase", () => {
  const at = (status: string, startsIn: number, ended = false) =>
    eventPhase({ status, startsAt: new Date(now.getTime() + startsIn * 1000), endedAt: ended ? now : null }, now);

  test("status wins over the clock, then the door opens an hour ahead", () => {
    expect(at("canceled", -HOUR, true)).toBe("canceled");
    expect(at("draft", -HOUR)).toBe("draft");
    expect(at("published", HOUR, true)).toBe("wrapup");
    expect(at("published", 2 * HOUR)).toBe("signup");
    expect(at("closed", 2 * HOUR)).toBe("signup");
    expect(at("published", HOUR)).toBe("start");
    expect(at("closed", -10 * HOUR)).toBe("start");
  });
});

describe("hq overview", () => {
  test("splits live, stale and upcoming runs, and lists series drafts to publish", () => {
    const live = event({ startsIn: -12 * 60 });
    register(live, 2, "checked_in");
    register(live, 3);
    register(live, 4, "checked_in", 1);
    const stale = event({ startsIn: -14 * HOUR });
    const seriesId = createSeries();
    const draft = event({ startsIn: 48 * HOUR, status: "draft", seriesId });
    const paid = event({ startsIn: 72 * HOUR, capacity: 2 });
    db.$client.query("INSERT INTO ticket_tiers (event_id, name, price_minor) VALUES (?, 'Start', 50000)").run(paid);
    register(paid, 2);
    register(paid, 3, "waitlisted");
    order("p1", paid, 2, "fulfilled", [{ kind: "ticket", name: "Start", unit: 50000 }]);
    order("p2", paid, 3, "refunded", [{ kind: "ticket", name: "Start", unit: 50000 }]);
    event({ startsIn: -48 * HOUR, endedAgo: 40 * HOUR });
    event({ startsIn: 24 * HOUR, status: "canceled" });
    event({ startsIn: -24 * HOUR, status: "draft" });

    const hq = hqOverview(db, admin, now);
    expect(hq.live).toEqual([expect.objectContaining({ id: live, checkedIn: 1, total: 2, minutesSinceStart: 12, ticketed: false })]);
    expect(hq.todo).toEqual([
      { kind: "end_event", eventId: stale, title: "run", startsAt: expect.any(String), hoursSinceStart: 14 },
      { kind: "publish_draft", eventId: draft, title: "run", city: expect.any(String), startsAt: expect.any(String), seriesId },
    ]);
    expect(hq.next.map(({ id, phase, registered, waitlisted, revenueMinor }) => ({ id, phase, registered, waitlisted, revenueMinor }))).toEqual([
      { id: draft, phase: "draft", registered: 0, waitlisted: 0, revenueMinor: null },
      { id: paid, phase: "signup", registered: 1, waitlisted: 1, revenueMinor: 50000 },
    ]);
  });

  test("an organizer sees their branch and the runs they are named on, nothing else", () => {
    const named = event({ startsIn: 24 * HOUR, city: "msk" });
    const branch = event({ startsIn: 25 * HOUR, city: "kzn" });
    event({ startsIn: 26 * HOUR, city: "spb" });
    db.$client.query("INSERT INTO event_organizers (event_id, user_id) VALUES (?, 5)").run(named);
    const organizer: Actor = { userId: 5, isGlobalAdmin: false, roles: new Map([["kzn", "admin"]]) };
    expect(hqOverview(db, organizer, now).next.map((row) => row.id)).toEqual([named, branch]);
    const nobody: Actor = { userId: 6, isGlobalAdmin: false, roles: new Map() };
    expect(hqOverview(db, nobody, now)).toEqual({ live: [], todo: [], next: [] });
  });
});

describe("roster", () => {
  test("first time means no earlier check-in anywhere; waitlist means an accepted offer", () => {
    const earlier = event({ startsIn: -72 * HOUR, endedAgo: 70 * HOUR });
    register(earlier, 2, "checked_in");
    register(earlier, 3); // signed up, never came: still a first-timer
    const later = event({ startsIn: 72 * HOUR });
    register(later, 2, "checked_in");
    const current = event({ startsIn: HOUR });
    for (const userId of [2, 3, 4]) register(current, userId);
    db.$client.query("INSERT INTO waitlist_offers (event_id, user_id, offered_at, expires_at, status) VALUES (?, 4, 0, 0, 'accepted'), (?, 3, 0, 0, 'superseded')").run(current, current);

    const flags = rosterFlags(db, current);
    expect(flags(2)).toEqual({ firstTime: false, fromWaitlist: false });
    expect(flags(3)).toEqual({ firstTime: true, fromWaitlist: false });
    expect(flags(4)).toEqual({ firstTime: true, fromWaitlist: true });
  });

  test("every door records how someone came through, and undoing clears it", () => {
    const id = event({ startsIn: 0 });
    for (const userId of [2, 3, 4]) register(id, userId);
    run(db, checkIn(id, 2, now));
    run(db, scanTicket(id, 3, now));
    run(db, manualToggleCheckin(id, 4, now));
    const method = (userId: number) => db.$client.query<{ checkin_method: string | null }, [number, number]>(
      "SELECT checkin_method FROM registrations WHERE event_id = ? AND user_id = ?",
    ).get(id, userId)?.checkin_method;
    expect([method(2), method(3), method(4)]).toEqual(["qr", "ticket", "manual"]);
    run(db, manualToggleCheckin(id, 4, now));
    expect(method(4)).toBeNull();
  });
});

describe("event summary", () => {
  test("wrap-up numbers: turnout, newcomers, money, refunds and merch left to hand out", () => {
    const seriesId = createSeries(1, unix(now) + 14 * 24 * HOUR);
    const id = event({ startsIn: -3 * HOUR, endedAgo: HOUR, seriesId });
    db.$client.query("INSERT INTO ticket_tiers (event_id, name, price_minor) VALUES (?, 'Start', 50000)").run(id);
    const veteran = event({ startsIn: -72 * HOUR, endedAgo: 70 * HOUR });
    register(veteran, 2, "checked_in");
    register(id, 1, "checked_in", 1);
    register(id, 2, "checked_in");
    register(id, 3, "checked_in");
    register(id, 4);
    register(id, 5, "waitlisted");
    db.$client.query("INSERT INTO chat_guests (chat_id, user_id, event_id, invite_link, status) VALUES (-1, 4, ?, 'x', 'removed')").run(id);
    order("a", id, 2, "fulfilled", [
      { kind: "ticket", name: "Start", unit: 50000 },
      { kind: "merchandise", name: "Cap", variant: "M", unit: 120000 },
    ]);
    order("b", id, 3, "fulfilled", [
      { kind: "ticket", name: "Start", unit: 50000 },
      { kind: "merchandise", name: "Cap", variant: "M", unit: 120000, handed: true },
    ]);
    order("c", id, 4, "refunded", [{ kind: "ticket", name: "Start", unit: 50000 }]);
    db.$client.query("INSERT INTO payment_attempts (id, order_id, idempotence_key) VALUES ('pa', 'c', 'k')").run();
    db.$client.query("INSERT INTO refunds (id, order_id, payment_attempt_id, idempotence_key, amount_minor, status, reason) VALUES ('r', 'c', 'pa', 'rk', 50000, 'succeeded', 'user_canceled')").run();

    const summary = eventSummary(db, id, now)!;
    expect(summary.phase).toBe("wrapup");
    expect(summary.counts).toEqual({ registered: 3, waitlisted: 1, checkedIn: 2, noShows: 1, staff: 1, turnout: 2 / 3 });
    expect(summary.newcomers).toEqual({ registered: 2, came: 1, missed: 1, removedFromChat: 1 });
    expect(summary.money).toEqual({
      revenueMinor: 340000,
      ticketsSold: 2,
      itemsSold: [{ name: "Cap", quantity: 2 }],
      refunds: { count: 1, amountMinor: 50000, pending: 0 },
    });
    expect(summary.merchOutstanding).toEqual({ people: 1, lines: [{ name: "Cap", variantName: "M", quantity: 1, people: 1 }] });
    expect(summary.cancelPreview).toEqual({ registered: 3, waitlisted: 1 });
    expect(summary.nextInSeries).toMatchObject({
      seriesId,
      eventId: null,
      startsAt: new Date((unix(now) + 14 * 24 * HOUR) * 1000).toISOString(),
      draftAt: new Date((unix(now) + 9 * 24 * HOUR) * 1000).toISOString(),
    });
  });

  test("a free run has no money block and the next spawned occurrence wins over the template date", () => {
    const seriesId = createSeries(1, unix(now) + 30 * 24 * HOUR);
    const id = event({ startsIn: 3 * HOUR, seriesId });
    const following = event({ startsIn: 7 * 24 * HOUR, status: "draft", seriesId });
    const summary = eventSummary(db, id, now)!;
    expect(summary.phase).toBe("signup");
    expect(summary.minutesToStart).toBe(180);
    expect(summary.money).toBeNull();
    expect(summary.nextInSeries).toMatchObject({ eventId: following, draftAt: null });
    expect(eventSummary(db, 999, now)).toBeNull();
  });
});

describe("series aggregates", () => {
  test("list status, held count, turnout and leaders", () => {
    const seriesId = createSeries();
    db.$client.query("INSERT INTO series_organizers (series_id, user_id) VALUES (?, 3), (?, 2)").run(seriesId, seriesId);
    const held = event({ startsIn: -72 * HOUR, endedAgo: 70 * HOUR, seriesId });
    register(held, 2, "checked_in");
    register(held, 3);
    event({ startsIn: -48 * HOUR, status: "canceled", seriesId });
    const draft = event({ startsIn: 48 * HOUR, status: "draft", seriesId });
    expect(seriesSummary(db, seriesId, now)).toEqual({
      held: 1,
      avgTurnout: 0.5,
      leaders: ["U2", "U3"],
      status: "draft_ready",
      nextUp: new Date((unix(now) + 48 * HOUR) * 1000).toISOString(),
      nextEventId: draft,
      pausedSince: null,
    });
    expect(seriesSummary(db, createSeries(), now)).toMatchObject({ status: "no_date", nextUp: null, held: 0, avgTurnout: null });
    expect(seriesSummary(db, createSeries(1, unix(now) + HOUR), now)).toMatchObject({ status: "scheduled", nextEventId: null });
    expect(seriesSummary(db, createSeries(0), now).status).toBe("paused");
  });

  test("an empty held run counts as 0% turnout, as in series stats", () => {
    const seriesId = createSeries();
    const full = event({ startsIn: -72 * HOUR, endedAgo: 70 * HOUR, seriesId });
    register(full, 2, "checked_in");
    event({ startsIn: -48 * HOUR, endedAgo: 46 * HOUR, seriesId });
    expect(seriesSummary(db, seriesId, now).avgTurnout).toBe(0.5);
  });

  test("a template date before this run is not its successor", () => {
    const seriesId = createSeries(1, unix(now) + HOUR);
    const id = event({ startsIn: 3 * HOUR, seriesId });
    expect(eventSummary(db, id, now)!.nextInSeries).toMatchObject({ eventId: null, startsAt: null, draftAt: null });
  });

  test("series stats average over held runs only and split first-timers from returning", () => {
    const seriesId = createSeries();
    const outside = event({ startsIn: -30 * 24 * HOUR, endedAgo: 29 * 24 * HOUR });
    register(outside, 3, "checked_in");
    const first = event({ startsIn: -14 * 24 * HOUR, endedAgo: 13 * 24 * HOUR, seriesId });
    register(first, 2, "checked_in");
    register(first, 3, "checked_in");
    const second = event({ startsIn: -7 * 24 * HOUR, endedAgo: 6 * 24 * HOUR, seriesId });
    register(second, 2, "checked_in");
    register(second, 4);
    const upcoming = event({ startsIn: 7 * 24 * HOUR, seriesId });
    register(upcoming, 5);

    const stats = seriesStats(db, seriesId);
    expect(stats.occurrences.map((occurrence) => occurrence.held)).toEqual([true, true, false]);
    expect(stats.totals).toMatchObject({ occurrences: 3, held: 2, turnout: 0.75, fillRate: 0.2, uniqueParticipants: 4, firstTime: 3, returning: 1 });
  });
});
