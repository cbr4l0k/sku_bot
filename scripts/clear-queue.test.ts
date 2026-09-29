import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { createDb, migrate } from "../packages/db/src";

import { clearQueue, queueOf } from "./clear-queue";

let db: Database;
const statuses = (eventId: number) => db
  .query<{ user_id: number; status: string }, [number]>("SELECT user_id, status FROM registrations WHERE event_id = ? ORDER BY user_id")
  .all(eventId);
const offers = () => db.query("SELECT user_id, event_id, status FROM waitlist_offers ORDER BY id").all();

beforeEach(() => {
  const drizzle = createDb(":memory:");
  migrate(drizzle);
  db = drizzle.$client;
  db.run("INSERT INTO users (id, first_name) VALUES (1, 'A'), (2, 'B'), (3, 'C'), (4, 'D'), (5, 'E')");
  db.run("INSERT INTO events (id, title, description, starts_at, location, created_by) VALUES (10, 'Run', '', 0, 'Park', 1), (20, 'Other', '', 0, 'Park', 1)");
  db.run(`INSERT INTO registrations (event_id, user_id, status) VALUES
    (10, 1, 'registered'), (10, 2, 'checked_in'), (10, 3, 'waitlisted'), (10, 4, 'waitlisted'), (10, 5, 'canceled'),
    (20, 3, 'waitlisted')`);
  db.run(`INSERT INTO waitlist_offers (event_id, user_id, offered_at, expires_at, status) VALUES
    (10, 3, 0, 9999999999, 'pending'), (10, 1, 0, 0, 'accepted'), (20, 3, 0, 9999999999, 'pending')`);
});

test("lists the queue in order with any pending offer", () => {
  expect(queueOf(db, 10).map((person) => [person.user_id, person.offer])).toEqual([[3, "pending offer"], [4, null]]);
});

test("cancels only the queued people of that event and supersedes their offers", () => {
  expect(clearQueue(db, 10, new Date())).toEqual({ registrationsCanceled: 2, offersSuperseded: 1 });
  expect(statuses(10)).toEqual([
    { user_id: 1, status: "registered" },
    { user_id: 2, status: "checked_in" },
    { user_id: 3, status: "canceled" },
    { user_id: 4, status: "canceled" },
    { user_id: 5, status: "canceled" },
  ]);
  expect(statuses(20)).toEqual([{ user_id: 3, status: "waitlisted" }]);
  expect(offers()).toEqual([
    { user_id: 3, event_id: 10, status: "superseded" },
    { user_id: 1, event_id: 10, status: "accepted" },
    { user_id: 3, event_id: 20, status: "pending" },
  ]);
  expect(queueOf(db, 10)).toEqual([]);
});

test("an empty queue is a no-op", () => {
  clearQueue(db, 10, new Date());
  expect(clearQueue(db, 10, new Date())).toEqual({ registrationsCanceled: 0, offersSuperseded: 0 });
});
