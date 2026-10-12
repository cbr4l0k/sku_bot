import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import { draftReviewEffects } from "../../src/core/alerts";
import { discardDraft, publishDraft } from "../../src/core/drafts";
import { run } from "../support/effect";

let db: Db;
const now = new Date("2030-01-01T12:00:00Z");

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  db.$client.exec(`
    INSERT INTO users (id, first_name, is_admin) VALUES (1, 'Lead', 0), (2, 'Branch admin', 0), (3, 'Club admin', 1), (4, 'Other branch', 0);
    INSERT INTO events (id, city, title, description, starts_at, location, capacity, status, created_by)
      VALUES (1, 'spb', 'Track night', '', 1893499200, 'Stadium', 10, 'draft', 1);
    INSERT INTO event_organizers (event_id, user_id) VALUES (1, 1);
    INSERT INTO user_city_roles (city, user_id, role) VALUES ('msk', 4, 'admin');
  `);
});

const recipients = () => run(db, draftReviewEffects(1)).map(({ userId, canPublish }) => ({ userId, canPublish }));

describe("who reviews a raised draft", () => {
  test("the leads and the branch's admins; only admins get the buttons", () => {
    db.$client.exec("INSERT INTO user_city_roles (city, user_id, role) VALUES ('spb', 2, 'admin')");
    expect(recipients()).toEqual([{ userId: 1, canPublish: false }, { userId: 2, canPublish: true }]);
  });

  test("the club's admins stand in for a branch with none", () => {
    expect(recipients()).toEqual([{ userId: 1, canPublish: false }, { userId: 3, canPublish: true }]);
  });

  test("a lead who also runs the branch is told once, with the buttons", () => {
    db.$client.exec("INSERT INTO user_city_roles (city, user_id, role) VALUES ('spb', 1, 'admin')");
    expect(recipients()).toEqual([{ userId: 1, canPublish: true }]);
  });

  test("nothing is sent for a run that is no longer a draft", () => {
    db.$client.exec("UPDATE events SET status = 'published'");
    expect(recipients()).toEqual([]);
  });
});

describe("handling a draft", () => {
  const status = () => db.$client.query<{ status: string }, []>("SELECT status FROM events WHERE id = 1").get()?.status;

  test("publishing flips a draft once", () => {
    expect(run(db, publishDraft(1, now))).toBe(true);
    expect(status()).toBe("published");
    expect(run(db, publishDraft(1, now))).toBe(false);
  });

  test("skipping deletes the draft and what hangs off it", () => {
    expect(run(db, discardDraft(1))).toBe("discarded");
    expect(status()).toBeUndefined();
    expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM event_organizers").get()?.count).toBe(0);
    expect(run(db, discardDraft(1))).toBe("not_draft");
  });

  test("a published run or one with payments is never deleted from chat", () => {
    db.$client.exec("INSERT INTO ticket_orders (id, event_id, user_id, ticket_name, amount_minor, status, expires_at) VALUES ('o1', 1, 1, 'x', 100, 'awaiting_payment', 1893499200)");
    expect(run(db, discardDraft(1))).toBe("has_orders");
    db.$client.exec("DELETE FROM ticket_orders; UPDATE events SET status = 'published'");
    expect(run(db, discardDraft(1))).toBe("not_draft");
    expect(status()).toBe("published");
  });
});
