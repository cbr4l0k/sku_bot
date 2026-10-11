import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import { sweepReminders, REMINDER_LEAD_SECONDS } from "../../src/core/reminders";
import { joinEvent } from "../../src/core/registration";
import { run } from "../support/effect";

let db: Db;
const startsAt = new Date("2030-01-01T19:00:00Z");
const before = (minutes: number) => new Date(startsAt.getTime() - minutes * 60_000);
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  for (let id = 1; id <= 6; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
  db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, reminders_enabled, created_by) VALUES (1, 'run', 'x', ?, 'park', 2, 'published', 1, 1)")
    .run(unix(startsAt));
});

const reminded = (at: Date) => {
  const effects = run(db, sweepReminders(at));
  if (!Array.isArray(effects)) throw new Error("sweepReminders failed");
  return effects.map((effect) => effect.userId);
};

describe("run reminders", () => {
  test("everyone holding a spot is reminded once, inside the lead and not before", () => {
    run(db, joinEvent(1, 1, before(600)));
    run(db, joinEvent(1, 2, before(600)));
    expect(reminded(before(REMINDER_LEAD_SECONDS / 60 + 1))).toEqual([]);
    expect(reminded(before(119))).toEqual([1, 2]);
    expect(reminded(before(100))).toEqual([]);
  });

  test("the queue, staff and anyone who left are not reminded", () => {
    run(db, joinEvent(1, 1, before(600)));
    run(db, joinEvent(1, 2, before(600)));
    run(db, joinEvent(1, 3, before(600)));
    run(db, joinEvent(1, 4, before(600)));
    db.$client.query("UPDATE registrations SET is_staff = 1 WHERE user_id = 2").run();
    db.$client.query("UPDATE registrations SET status = 'canceled' WHERE user_id = 4").run();
    expect(reminded(before(60))).toEqual([1]);
  });

  test("someone who signed up after the lead began is not reminded of what they just chose", () => {
    run(db, joinEvent(1, 1, before(600)));
    run(db, joinEvent(1, 2, before(30)));
    expect(reminded(before(20))).toEqual([1]);
  });

  test("nothing goes out with reminders off, or for an ended, canceled or started run", () => {
    run(db, joinEvent(1, 1, before(600)));
    for (const sql of [
      "UPDATE events SET reminders_enabled = 0",
      "UPDATE events SET reminders_enabled = 1, ended_at = 1",
      "UPDATE events SET ended_at = NULL, status = 'canceled'",
    ]) {
      db.$client.query(sql).run();
      expect(reminded(before(60))).toEqual([]);
    }
    db.$client.query("UPDATE events SET status = 'published'").run();
    expect(reminded(new Date(startsAt.getTime() + 60_000))).toEqual([]);
  });
});
