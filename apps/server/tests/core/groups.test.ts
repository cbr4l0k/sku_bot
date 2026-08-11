import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import { canSeeEvent, groupsOfEvent, groupsOfUser, setEventGroups, setUserGroups } from "../../src/core/groups";
import { cancelRegistration, joinEvent } from "../../src/core/registration";
import { loadEnv } from "../../src/env";

const base = { BOT_TOKEN: "12345:token", DOMAIN: "club.example.com", ADMIN_IDS: "1001", WEBHOOK_SECRET: "webhook", CHECKIN_SECRET: "checkin", NODE_ENV: "test" };
const parse = (EVENT_GROUPS?: string) => loadEnv(EVENT_GROUPS === undefined ? base : { ...base, EVENT_GROUPS }).EVENT_GROUPS;

describe("EVENT_GROUPS parsing", () => {
  test("defaults to an empty catalog", () => { expect(parse()).toEqual([]); expect(parse("")).toEqual([]); });
  test("trims, drops blanks, and de-duplicates", () => { expect(parse(" alumni , coaches ,, alumni ")).toEqual(["alumni", "coaches"]); });
  test("rejects an overlong name", () => { expect(() => parse("a".repeat(41))).toThrow(/longer than 40 characters/); });
});

describe("group-restricted events", () => {
  let db: Db;
  const now = new Date("2030-01-01T12:00:00Z");
  const unix = (date: Date) => Math.floor(date.getTime() / 1000);
  const event = (id: number) => {
    db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, created_by) VALUES (?, 'run', 'x', ?, 'park', NULL, 'published', 1)")
      .run(id, unix(new Date(now.getTime() + 86_400_000)));
    return id;
  };

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db);
    for (let id = 1; id <= 4; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
  });

  test("an event without groups stays open to everyone", () => {
    event(1);
    expect(canSeeEvent(db, 1, 2)).toBe(true);
    expect(joinEvent(db, 1, 2, now)).toEqual({ status: "registered" });
  });

  test("a restricted event is visible and joinable only to members", () => {
    event(1);
    setEventGroups(db, 1, ["alumni"]);
    setUserGroups(db, 2, ["alumni"]);

    expect(canSeeEvent(db, 1, 2)).toBe(true);
    expect(joinEvent(db, 1, 2, now)).toEqual({ status: "registered" });
    expect(canSeeEvent(db, 1, 3)).toBe(false);
    expect(joinEvent(db, 1, 3, now)).toEqual({ error: "not_eligible" });
  });

  test("membership in any one of the listed groups is enough", () => {
    event(1);
    setEventGroups(db, 1, ["alumni", "coaches"]);
    setUserGroups(db, 3, ["coaches"]);
    expect(canSeeEvent(db, 1, 3)).toBe(true);
  });

  test("restricting an event afterwards leaves existing registrations visible and cancelable", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    setEventGroups(db, 1, ["alumni"]);

    expect(canSeeEvent(db, 1, 2)).toBe(true);
    cancelRegistration(db, 1, 2, now);
    // Once cancelled the exemption lapses, so an outsider cannot slip back in.
    expect(canSeeEvent(db, 1, 2)).toBe(false);
    expect(joinEvent(db, 1, 2, now)).toEqual({ error: "not_eligible" });
  });

  test("assignments replace rather than accumulate, and are sorted and de-duplicated", () => {
    event(1);
    setEventGroups(db, 1, ["coaches", "alumni", "alumni"]);
    expect(groupsOfEvent(db, 1)).toEqual(["alumni", "coaches"]);
    setEventGroups(db, 1, ["alumni"]);
    expect(groupsOfEvent(db, 1)).toEqual(["alumni"]);

    setUserGroups(db, 2, ["coaches"]);
    expect(groupsOfUser(db, 2)).toEqual(["coaches"]);
    setUserGroups(db, 2, []);
    expect(groupsOfUser(db, 2)).toEqual([]);
  });

  test("a group dropped from the catalog keeps its event restricted", () => {
    event(1);
    setEventGroups(db, 1, ["retired-group"]);
    expect(canSeeEvent(db, 1, 2)).toBe(false);
  });
});
