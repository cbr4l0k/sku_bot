import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import { joinEvent } from "../../src/core/registration";
import { staffUserIds, syncAllStaff, syncCityStaff, syncEventStaff } from "../../src/core/staff";
import { eventStats } from "../../src/core/stats";
import { endEvent } from "../../src/core/waitlist";

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
  test("the club's admins, the branch's admins, and whoever is named on the event", () => {
    event(10);
    globalAdmin(2);
    cityRole(3, "msk", "admin");
    cityRole(4, "spb", "admin");
    nameOnEvent(1, 5);
    expect(staffUserIds(db, 1)).toEqual([2, 3, 5]);
  });

  test("a branch organizer is not staff on every run of their branch, only on the ones they are named on", () => {
    event(10);
    cityRole(6, "msk", "organizer");
    expect(staffUserIds(db, 1)).toEqual([]);
    nameOnEvent(1, 6);
    expect(staffUserIds(db, 1)).toEqual([6]);
  });

  test("a banned account is off the list however it got there", () => {
    event(10);
    globalAdmin(2);
    db.$client.query("UPDATE users SET is_banned = 1 WHERE id = 2").run();
    expect(staffUserIds(db, 1)).toEqual([]);
  });
});

describe("putting staff on the roster", () => {
  test("staff land as ordinary registered rows, flagged, and syncing again changes nothing", () => {
    event(10);
    globalAdmin(2);
    cityRole(3, "msk", "admin");
    expect(syncEventStaff(db, 1, now)).toEqual({ added: 2, removed: 0 });
    expect(rows(1)).toEqual([
      { user_id: 2, status: "registered", is_staff: 1 },
      { user_id: 3, status: "registered", is_staff: 1 },
    ]);
    expect(syncEventStaff(db, 1, now)).toEqual({ added: 0, removed: 0 });
  });

  test("someone who signed up as a participant keeps the spot they took", () => {
    event(10);
    joinEvent(db, 1, 2, now);
    globalAdmin(2);
    syncEventStaff(db, 1, now);
    expect(rows(1)).toEqual([{ user_id: 2, status: "registered", is_staff: 0 }]);
  });

  test("an admin who took themselves off an event is not put back on it", () => {
    event(10);
    globalAdmin(2);
    syncEventStaff(db, 1, now);
    db.$client.query("UPDATE registrations SET status = 'canceled' WHERE event_id = 1 AND user_id = 2").run();
    expect(syncEventStaff(db, 1, now)).toEqual({ added: 0, removed: 0 });
    expect(rows(1)).toEqual([{ user_id: 2, status: "canceled", is_staff: 1 }]);
  });

  test("losing the job clears an untouched row, but never one that turned up", () => {
    event(10);
    globalAdmin(2);
    nameOnEvent(1, 5);
    syncEventStaff(db, 1, now);
    db.$client.query("UPDATE registrations SET status = 'checked_in', checked_in_at = ? WHERE event_id = 1 AND user_id = 5").run(unix(now));

    db.$client.query("UPDATE users SET is_admin = 0 WHERE id = 2").run();
    db.$client.query("DELETE FROM event_organizers WHERE event_id = 1 AND user_id = 5").run();
    expect(syncEventStaff(db, 1, now)).toEqual({ added: 0, removed: 1 });
    // The night still records who was actually there.
    expect(rows(1)).toEqual([{ user_id: 5, status: "checked_in", is_staff: 1 }]);
  });

  test("only runs that could still be checked into are staffed", () => {
    event(10);
    event(10, 2);
    globalAdmin(2);
    endEvent(db, 1, now);
    db.$client.query("UPDATE events SET status = 'canceled' WHERE id = 2").run();
    syncAllStaff(db, now);
    expect(rows(1)).toEqual([]);
    expect(rows(2)).toEqual([]);
  });

  test("a branch role reaches every live run of that branch and no other", () => {
    event(10, 1, "msk");
    event(10, 2, "spb");
    cityRole(3, "msk", "admin");
    syncCityStaff(db, "msk", now);
    expect(staffRows(1)).toEqual([3]);
    expect(staffRows(2)).toEqual([]);
  });
});

describe("staff hold no spot", () => {
  test("a full-to-the-staff event still admits its first real participant", () => {
    event(1);
    globalAdmin(2);
    cityRole(3, "msk", "admin");
    syncEventStaff(db, 1, now);
    // Three rows on a capacity-of-one event, and the spot is still free.
    expect(joinEvent(db, 1, 6, now)).toEqual({ status: "registered" });
    expect(joinEvent(db, 1, 7, now)).toEqual({ status: "waitlisted", position: 1 });
  });

  test("the numbers count the club's guests, and the staff apart from them", () => {
    event(10);
    globalAdmin(2);
    syncEventStaff(db, 1, now);
    joinEvent(db, 1, 6, now);
    db.$client.query("UPDATE registrations SET status = 'checked_in', checked_in_at = ? WHERE event_id = 1 AND user_id = 2").run(unix(now));

    const stats = eventStats(db, 1);
    expect(stats).toMatchObject({ registered: 1, checkedIn: 0, staff: 1, staffCheckedIn: 1 });
    // A staff member scanning in does not move the attendance rate.
    expect(stats.attendanceRate).toBe(0);
  });
});
