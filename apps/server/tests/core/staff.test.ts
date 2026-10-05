import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import { joinEvent } from "../../src/core/registration";
import { staffUserIds, syncAllStaff, syncEventStaff } from "../../src/core/staff";
import { eventStats } from "../../src/core/stats";
import { endEvent, reopenEvent } from "../../src/core/waitlist";
import { run } from "../support/effect";

let db: Db;
const now = new Date("2030-01-01T12:00:00Z");
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  for (let id = 1; id <= 8; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
});

const event = (capacity: number | null, id = 1, city = "msk") => {
  db.$client
    .query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, city, created_by) VALUES (?, 'run', 'x', ?, 'park', ?, 'published', ?, 1)")
    .run(id, unix(new Date(now.getTime() + 86_400_000)), capacity, city);
  return id;
};
const globalAdmin = (userId: number) => db.$client.query("UPDATE users SET is_admin = 1 WHERE id = ?").run(userId);
const cityRole = (userId: number, city: string, role: string) =>
  db.$client.query("INSERT INTO user_city_roles (city, user_id, role) VALUES (?, ?, ?)").run(city, userId, role);
const nameOnEvent = (eventId: number, userId: number) =>
  db.$client.query("INSERT INTO event_organizers (event_id, user_id) VALUES (?, ?)").run(eventId, userId);
const rows = (eventId: number) => db.$client
  .query<{ user_id: number; status: string; is_staff: number }, [number]>(
    "SELECT user_id, status, is_staff FROM registrations WHERE event_id = ? ORDER BY user_id",
  )
  .all(eventId);
const staffRows = (eventId: number) => rows(eventId).filter((row) => row.is_staff === 1).map((row) => row.user_id);

describe("who counts as staff", () => {
  test("only whoever is named as leading the event, whatever their role", () => {
    event(10);
    globalAdmin(2);
    cityRole(3, "msk", "admin");
    cityRole(4, "msk", "organizer");
    nameOnEvent(1, 3);
    nameOnEvent(1, 4);
    nameOnEvent(1, 5);
    expect(run(db, staffUserIds(1))).toEqual([3, 4, 5]);
  });

  test("an admin who does not lead the event is not staff on it", () => {
    event(10);
    globalAdmin(2);
    cityRole(3, "msk", "admin");
    expect(run(db, staffUserIds(1))).toEqual([]);
  });

  test("a banned account is off the list however it got there", () => {
    event(10);
    nameOnEvent(1, 2);
    db.$client.query("UPDATE users SET is_banned = 1 WHERE id = 2").run();
    expect(run(db, staffUserIds(1))).toEqual([]);
  });
});

describe("putting staff on the roster", () => {
  test("leads land as ordinary registered rows, flagged, and syncing again changes nothing", () => {
    event(10);
    globalAdmin(2);
    nameOnEvent(1, 3);
    nameOnEvent(1, 4);
    expect(run(db, syncEventStaff(1, now))).toEqual({ added: 2, removed: 0 });
    expect(rows(1)).toEqual([
      { user_id: 3, status: "registered", is_staff: 1 },
      { user_id: 4, status: "registered", is_staff: 1 },
    ]);
    expect(run(db, syncEventStaff(1, now))).toEqual({ added: 0, removed: 0 });
  });

  test("someone who signed up as a participant keeps the spot they took", () => {
    event(10);
    run(db, joinEvent(1, 2, now));
    nameOnEvent(1, 2);
    run(db, syncEventStaff(1, now));
    expect(rows(1)).toEqual([{ user_id: 2, status: "registered", is_staff: 0 }]);
  });

  test("a lead who took themselves off an event is not put back on it", () => {
    event(10);
    nameOnEvent(1, 2);
    run(db, syncEventStaff(1, now));
    db.$client.query("UPDATE registrations SET status = 'canceled' WHERE event_id = 1 AND user_id = 2").run();
    expect(run(db, syncEventStaff(1, now))).toEqual({ added: 0, removed: 0 });
    expect(rows(1)).toEqual([{ user_id: 2, status: "canceled", is_staff: 1 }]);
  });

  test("losing the lead clears an untouched row, but never one that turned up", () => {
    event(10);
    nameOnEvent(1, 2);
    nameOnEvent(1, 5);
    run(db, syncEventStaff(1, now));
    db.$client.query("UPDATE registrations SET status = 'checked_in', checked_in_at = ? WHERE event_id = 1 AND user_id = 5").run(unix(now));

    db.$client.query("DELETE FROM event_organizers WHERE event_id = 1").run();
    expect(run(db, syncEventStaff(1, now))).toEqual({ added: 0, removed: 1 });
    // The night still records who was actually there.
    expect(rows(1)).toEqual([{ user_id: 5, status: "checked_in", is_staff: 1 }]);
  });

  test("a former lead who cancelled and signs up again takes a spot like anyone else", () => {
    event(1);
    nameOnEvent(1, 2);
    run(db, syncEventStaff(1, now));
    db.$client.query("UPDATE registrations SET status = 'canceled' WHERE event_id = 1 AND user_id = 2").run();
    db.$client.query("DELETE FROM event_organizers WHERE event_id = 1").run();
    run(db, syncEventStaff(1, now));
    expect(rows(1)).toEqual([{ user_id: 2, status: "canceled", is_staff: 0 }]);

    expect(run(db, joinEvent(1, 2, now))).toEqual({ status: "registered" });
    expect(run(db, joinEvent(1, 6, now))).toEqual({ status: "waitlisted", position: 1 });
  });

  test("a lead waiting in their own run's queue joins the roster as staff and drops their offer", () => {
    event(1);
    run(db, joinEvent(1, 6, now));
    run(db, joinEvent(1, 2, now));
    db.$client.query("INSERT INTO waitlist_offers (event_id, user_id, offered_at, expires_at) VALUES (1, 2, ?, ?)").run(unix(now), unix(now) + 600);
    nameOnEvent(1, 2);
    expect(run(db, syncEventStaff(1, now))).toEqual({ added: 1, removed: 0 });
    expect(rows(1)).toEqual([
      { user_id: 2, status: "registered", is_staff: 1 },
      { user_id: 6, status: "registered", is_staff: 0 },
    ]);
    expect(db.$client.query("SELECT status FROM waitlist_offers WHERE user_id = 2").get()).toEqual({ status: "superseded" });
  });

  test("an ended run that is reopened can be brought back into line", () => {
    event(10);
    globalAdmin(2);
    db.$client.query("INSERT INTO registrations (event_id, user_id, status, is_staff) VALUES (1, 2, 'registered', 1)").run();
    run(db, endEvent(1, now));
    run(db, syncAllStaff(now));
    expect(staffRows(1)).toEqual([2]);
    run(db, reopenEvent(1, now));
    run(db, syncEventStaff(1, now));
    expect(staffRows(1)).toEqual([]);
  });

  test("rosters filled under the old every-admin rule are cleared of admins who do not lead", () => {
    event(10);
    globalAdmin(2);
    nameOnEvent(1, 3);
    db.$client.query("INSERT INTO registrations (event_id, user_id, status, is_staff) VALUES (1, 2, 'registered', 1)").run();
    run(db, syncAllStaff(now));
    expect(staffRows(1)).toEqual([3]);
  });

  test("only runs that could still be checked into are staffed", () => {
    event(10);
    event(10, 2);
    nameOnEvent(1, 2);
    nameOnEvent(2, 2);
    run(db, endEvent(1, now));
    db.$client.query("UPDATE events SET status = 'canceled' WHERE id = 2").run();
    run(db, syncAllStaff(now));
    expect(rows(1)).toEqual([]);
    expect(rows(2)).toEqual([]);
  });
});

describe("staff hold no spot", () => {
  test("a full-to-the-staff event still admits its first real participant", () => {
    event(1);
    nameOnEvent(1, 2);
    nameOnEvent(1, 3);
    run(db, syncEventStaff(1, now));
    // Three rows on a capacity-of-one event, and the spot is still free.
    expect(run(db, joinEvent(1, 6, now))).toEqual({ status: "registered" });
    expect(run(db, joinEvent(1, 7, now))).toEqual({ status: "waitlisted", position: 1 });
  });

  test("the numbers count the club's guests, and the staff apart from them", () => {
    event(10);
    nameOnEvent(1, 2);
    run(db, syncEventStaff(1, now));
    run(db, joinEvent(1, 6, now));
    db.$client.query("UPDATE registrations SET status = 'checked_in', checked_in_at = ? WHERE event_id = 1 AND user_id = 2").run(unix(now));

    const stats = run(db, eventStats(1));
    expect(stats).toMatchObject({ registered: 1, checkedIn: 0, staff: 1, staffCheckedIn: 1 });
    // A staff member scanning in does not move the attendance rate.
    expect(stats.attendanceRate).toBe(0);
  });
});

describe("admins who do not lead", () => {
  test("take a spot when they sign up, like anyone else", () => {
    event(1);
    globalAdmin(2);
    cityRole(3, "msk", "admin");
    run(db, syncEventStaff(1, now));
    expect(rows(1)).toEqual([]);
    expect(run(db, joinEvent(1, 2, now))).toEqual({ status: "registered" });
    expect(run(db, joinEvent(1, 3, now))).toEqual({ status: "waitlisted", position: 1 });
    expect(run(db, eventStats(1))).toMatchObject({ registered: 1, waitlisted: 1, staff: 0 });
  });
});
