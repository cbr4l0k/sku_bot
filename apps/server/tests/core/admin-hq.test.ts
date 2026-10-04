import { beforeEach, describe, expect, test } from "bun:test";
import type { CityRole, CitySlug } from "@sku/cities";
import { createDb, migrate, type Db } from "@sku/db";

import { needsAttention } from "../../src/core/attention";
import type { Actor } from "../../src/core/cities";
import { personCard, setCityRoles } from "../../src/core/people";
import { monthStats } from "../../src/core/stats";
import { run } from "../support/effect";

let db: Db;
// 2030-03-15 15:00 in Moscow.
const now = new Date("2030-03-15T12:00:00Z");
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const actor = (userId: number, isGlobalAdmin: boolean, roles: [CitySlug, CityRole][] = []): Actor =>
  ({ userId, isGlobalAdmin, roles: new Map(roles) });

const event = (city: CitySlug, startsAt: string, status = "published", extra: { seriesId?: number; endedAt?: string } = {}) =>
  db.$client.query<{ id: number }, [string, string, number, string, number | null, number | null]>(`
    INSERT INTO events (city, title, description, starts_at, location, status, series_id, ended_at, created_by)
    VALUES (?, 'Run ' || ?, '', ?, 'park', ?, ?, ?, 1) RETURNING id
  `).get(city, startsAt, unix(startsAt), status, extra.seriesId ?? null, extra.endedAt ? unix(extra.endedAt) : null)!.id;

const register = (eventId: number, userId: number, status: string, isStaff = false) =>
  db.$client.query("INSERT INTO registrations (event_id, user_id, status, is_staff) VALUES (?, ?, ?, ?)").run(eventId, userId, status, isStaff ? 1 : 0);

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  for (let id = 1; id <= 6; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
});

describe("needs attention", () => {
  const failedRefund = (eventId: number, orderId: string, reason: string | null) => {
    db.$client.query(`
      INSERT INTO ticket_orders (id, event_id, user_id, amount_minor, status, expires_at) VALUES (?, ?, 2, 170000, 'refund_failed', 0)
    `).run(orderId, eventId);
    db.$client.query("INSERT INTO payment_attempts (id, order_id, idempotence_key, status) VALUES (?, ?, ?, 'succeeded')").run(`pa-${orderId}`, orderId, `k-${orderId}`);
    db.$client.query(`
      INSERT INTO refunds (id, order_id, payment_attempt_id, idempotence_key, amount_minor, status, reason, failure_reason, created_at)
      VALUES (?, ?, ?, ?, 170000, 'canceled', 'admin', ?, 100)
    `).run(`r-${orderId}`, orderId, `pa-${orderId}`, `rk-${orderId}`, reason);
  };

  test("lists branchless chats, upcoming series drafts and failed refunds with what is needed to act", () => {
    db.$client.exec("INSERT INTO chats (id, city, title) VALUES (-1, NULL, 'Lost'), (-2, 'spb', 'Filed')");
    const series = db.$client.query<{ id: number }, []>(`
      INSERT INTO event_series (city, title, description, location, created_by) VALUES ('spb', 'Intervals', '', 'track', 1) RETURNING id
    `).get()!.id;
    const draft = event("spb", "2030-03-20T16:00:00Z", "draft", { seriesId: series });
    event("spb", "2030-03-01T16:00:00Z", "draft", { seriesId: series }); // date gone by
    event("spb", "2030-03-21T16:00:00Z", "draft"); // a hand-made draft is nobody's backlog
    const night = event("spb", "2030-03-10T19:00:00Z");
    failedRefund(night, "ord-1", "card_expired");

    const result = needsAttention(db, ["spb", "msk", "kzn"], true, now);
    expect(result.unassignedChats.map((chat) => chat.id)).toEqual([-1]);
    expect(result.seriesDrafts).toEqual([
      { eventId: draft, seriesId: series, seriesTitle: "Intervals", title: "Run 2030-03-20T16:00:00Z", city: "spb", startsAt: "2030-03-20T16:00:00.000Z" },
    ]);
    expect(result.failedRefunds).toMatchObject([
      { orderId: "ord-1", eventId: night, amountMinor: 170000, failureReason: "card_expired", buyer: { userId: 2 } },
    ]);
  });

  test("a branch admin sees only their branches, and no branchless chats", () => {
    db.$client.exec("INSERT INTO chats (id, city, title) VALUES (-1, NULL, 'Lost')");
    failedRefund(event("spb", "2030-03-10T19:00:00Z"), "ord-spb", null);
    failedRefund(event("msk", "2030-03-10T19:00:00Z"), "ord-msk", "insufficient_funds");

    const result = needsAttention(db, ["msk"], false, now);
    expect(result.unassignedChats).toEqual([]);
    expect(result.failedRefunds.map((refund) => refund.orderId)).toEqual(["ord-msk"]);
    expect(needsAttention(db, [], false, now)).toEqual({ unassignedChats: [], seriesDrafts: [], failedRefunds: [] });
  });
});

describe("month in numbers", () => {
  test("counts runs held so far this calendar month, unique runners and turnout", () => {
    const a = event("spb", "2030-03-02T16:00:00Z");
    const b = event("spb", "2030-03-09T16:00:00Z", "closed");
    event("spb", "2030-03-20T16:00:00Z"); // not held yet
    event("spb", "2030-03-05T16:00:00Z", "canceled");
    event("spb", "2030-03-06T16:00:00Z", "draft");
    const feb = event("spb", "2030-02-28T20:30:00Z"); // 23:30 Moscow — still February
    const moscow = event("msk", "2030-03-03T16:00:00Z");
    register(a, 2, "checked_in");
    register(a, 3, "registered");
    register(a, 4, "checked_in", true); // staff never count
    register(b, 2, "checked_in");
    register(b, 5, "checked_in");
    register(b, 6, "canceled");
    register(feb, 3, "checked_in");
    register(moscow, 6, "checked_in");

    expect(monthStats(db, "spb", now)).toEqual({ month: "2030-03", events: 2, runners: 2, turnout: 3 / 4 });
    expect(monthStats(db, null, now)).toEqual({ month: "2030-03", events: 3, runners: 3, turnout: 4 / 5 });
    expect(monthStats(db, "kzn", now)).toEqual({ month: "2030-03", events: 0, runners: 0, turnout: null });
  });

  test("the month turns over at Moscow midnight, not UTC", () => {
    // 2030-03-31 22:30 UTC is already April 1st in Moscow.
    expect(monthStats(db, null, new Date("2030-03-31T22:30:00Z")).month).toBe("2030-04");
  });
});

describe("the person card", () => {
  test("shows profile, record and every branch's role with what the viewer may set", () => {
    db.$client.query("UPDATE users SET username = 'anya', phone = '+79210000014' WHERE id = 2").run();
    db.$client.exec("INSERT INTO user_city_roles (city, user_id, role) VALUES ('spb', 2, 'organizer'), ('msk', 2, 'admin')");
    const ended = event("spb", "2030-03-02T16:00:00Z", "published", { endedAt: "2030-03-02T18:00:00Z" });
    const ended2 = event("spb", "2030-03-03T16:00:00Z", "published", { endedAt: "2030-03-03T18:00:00Z" });
    const upcoming = event("spb", "2030-03-20T16:00:00Z");
    register(ended, 2, "checked_in");
    register(ended2, 2, "registered");
    register(upcoming, 2, "registered");
    db.$client.query("INSERT INTO event_organizers (event_id, user_id) VALUES (?, 2), (?, 2)").run(ended, upcoming);
    const draft = event("spb", "2030-03-25T16:00:00Z", "draft");
    db.$client.query("INSERT INTO event_organizers (event_id, user_id) VALUES (?, 2)").run(draft);

    const card = personCard(db, actor(1, false, [["spb", "admin"]]), 2, new Set());
    expect(card).toMatchObject({
      username: "anya", phone: "+79210000014", isBanned: false, canBlock: false,
      stats: { signUps: 3, turnout: 0.5, led: 2 },
      roles: [
        { city: "spb", role: "organizer", grantable: [null, "organizer"] },
        { city: "msk", role: "admin", grantable: [] },
        { city: "kzn", role: null, grantable: [] },
      ],
    });
    expect(personCard(db, actor(1, true), 2, new Set())?.roles[2]).toEqual({ city: "kzn", role: null, grantable: [null, "organizer", "admin"] });
    expect(personCard(db, actor(1, true), 99, new Set())).toBeNull();
  });

  test("saving several branches is all or nothing under canGrantRole", () => {
    const branchAdmin = actor(1, false, [["spb", "admin"]]);
    // Re-sending an untouched branch is fine; touching another branch refuses the lot.
    expect(run(db, setCityRoles(branchAdmin, 2, [{ city: "spb", role: "organizer" }, { city: "msk", role: "organizer" }]))).toEqual({ error: "forbidden" });
    expect(db.$client.query("SELECT count(*) AS n FROM user_city_roles").get()).toEqual({ n: 0 });

    expect(run(db, setCityRoles(branchAdmin, 2, [{ city: "spb", role: "organizer" }, { city: "msk", role: null }]))).toEqual({ changed: ["spb"] });
    expect(run(db, setCityRoles(branchAdmin, 2, [{ city: "spb", role: "admin" }]))).toEqual({ error: "forbidden" });
    expect(run(db, setCityRoles(branchAdmin, 2, [{ city: "spb", role: "organizer" }, { city: "spb", role: null }]))).toEqual({ error: "duplicate_city" });

    expect(run(db, setCityRoles(actor(1, true), 2, [{ city: "spb", role: null }, { city: "kzn", role: "admin" }]))).toEqual({ changed: ["spb", "kzn"] });
    expect(db.$client.query("SELECT city, role FROM user_city_roles WHERE user_id = 2").all()).toEqual([{ city: "kzn", role: "admin" }]);
  });
});
