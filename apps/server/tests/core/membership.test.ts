import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import {
  MEMBERSHIP_TTL_MS,
  canSeeEvent,
  chatsGatingUpcomingEvents,
  chatsOfEvent,
  refreshMemberships,
  setEventChats,
  type MembershipProbe,
} from "../../src/core/membership";
import { cancelRegistration, joinEvent } from "../../src/core/registration";
import { loadEnv } from "../../src/env";

const base = { BOT_TOKEN: "12345:token", DOMAIN: "club.example.com", ADMIN_IDS: "1001", WEBHOOK_SECRET: "webhook", CHECKIN_SECRET: "checkin", NODE_ENV: "test" };
const parse = (EVENT_GROUPS?: string) => loadEnv(EVENT_GROUPS === undefined ? base : { ...base, EVENT_GROUPS }).EVENT_GROUPS;

describe("EVENT_GROUPS parsing", () => {
  test("defaults to an empty catalog", () => { expect(parse()).toEqual([]); expect(parse("")).toEqual([]); });
  test("reads negative supergroup ids, trims, and de-duplicates", () => {
    expect(parse(" -1001234567890 , -1009876543210 ,, -1001234567890 ")).toEqual([-1001234567890, -1009876543210]);
  });
  test("rejects anything that is not a chat id", () => {
    expect(() => parse("-1001234567890,alumni")).toThrow(/"alumni" is not a Telegram chat id/);
  });
});

describe("Telegram-gated events", () => {
  let db: Db;
  const now = new Date("2030-01-01T12:00:00Z");
  const unix = (date: Date) => Math.floor(date.getTime() / 1000);
  const CHAT = -1001234567890;
  const OTHER = -1009876543210;

  /** Stands in for getChatMember; records every lookup so we can assert on caching. */
  const probeFor = (members: Record<number, number[]>, failing: number[] = [], moved: Record<number, number> = {}) => {
    const calls: Array<[number, number]> = [];
    const probe: MembershipProbe = async (chatId, userId) => {
      calls.push([chatId, userId]);
      if (moved[chatId] !== undefined) return { movedTo: moved[chatId] as number };
      if (failing.includes(chatId)) return null;
      return { isMember: (members[chatId] ?? []).includes(userId) };
    };
    return { probe, calls };
  };

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

  test("an event without chats stays open to everyone", () => {
    event(1);
    expect(canSeeEvent(db, 1, 2)).toBe(true);
    expect(joinEvent(db, 1, 2, now)).toEqual({ status: "registered" });
  });

  test("only chat members can see and join a restricted event", async () => {
    event(1);
    setEventChats(db, 1, [CHAT]);
    const { probe } = probeFor({ [CHAT]: [2] });

    await refreshMemberships(db, probe, 2, [CHAT], now);
    await refreshMemberships(db, probe, 3, [CHAT], now);

    expect(canSeeEvent(db, 1, 2)).toBe(true);
    expect(joinEvent(db, 1, 2, now)).toEqual({ status: "registered" });
    expect(canSeeEvent(db, 1, 3)).toBe(false);
    expect(joinEvent(db, 1, 3, now)).toEqual({ error: "not_eligible" });
  });

  test("membership in any one of the listed chats is enough", async () => {
    event(1);
    setEventChats(db, 1, [CHAT, OTHER]);
    const { probe } = probeFor({ [OTHER]: [3] });
    await refreshMemberships(db, probe, 3, [CHAT, OTHER], now);
    expect(canSeeEvent(db, 1, 3)).toBe(true);
  });

  test("answers are cached until the TTL lapses, then re-asked", async () => {
    const { probe, calls } = probeFor({ [CHAT]: [2] });
    await refreshMemberships(db, probe, 2, [CHAT], now);
    await refreshMemberships(db, probe, 2, [CHAT], new Date(now.getTime() + MEMBERSHIP_TTL_MS - 1));
    expect(calls).toHaveLength(1);

    await refreshMemberships(db, probe, 2, [CHAT], new Date(now.getTime() + MEMBERSHIP_TTL_MS));
    expect(calls).toHaveLength(2);
  });

  test("leaving the chat closes the event again once the answer is refreshed", async () => {
    event(1);
    setEventChats(db, 1, [CHAT]);
    const present = probeFor({ [CHAT]: [2] });
    await refreshMemberships(db, present.probe, 2, [CHAT], now);
    expect(canSeeEvent(db, 1, 2)).toBe(true);

    const gone = probeFor({});
    await refreshMemberships(db, gone.probe, 2, [CHAT], new Date(now.getTime() + MEMBERSHIP_TTL_MS));
    expect(canSeeEvent(db, 1, 2)).toBe(false);
  });

  test("a failed lookup keeps the last answer, and closes the event when there is none", async () => {
    event(1);
    setEventChats(db, 1, [CHAT]);
    const good = probeFor({ [CHAT]: [2] });
    await refreshMemberships(db, good.probe, 2, [CHAT], now);

    const broken = probeFor({}, [CHAT]);
    await refreshMemberships(db, broken.probe, 2, [CHAT], new Date(now.getTime() + MEMBERSHIP_TTL_MS));
    expect(canSeeEvent(db, 1, 2)).toBe(true);

    // User 3 was never resolved, so an unreachable chat must not open the event to them.
    await refreshMemberships(db, broken.probe, 3, [CHAT], now);
    expect(canSeeEvent(db, 1, 3)).toBe(false);
  });

  test("a group upgraded to a supergroup carries its restriction to the new chat id", async () => {
    event(1);
    setEventChats(db, 1, [CHAT]);
    // Telegram answers lookups on the old id with the supergroup's new id.
    const { probe } = probeFor({ [OTHER]: [2] }, [], { [CHAT]: OTHER });

    await refreshMemberships(db, probe, 2, [CHAT], now);

    expect(chatsOfEvent(db, 1)).toEqual([OTHER]);
    expect(canSeeEvent(db, 1, 2)).toBe(true);
    expect(joinEvent(db, 1, 2, now)).toEqual({ status: "registered" });
  });

  test("an upgrade does not admit a non-member of the new chat", async () => {
    event(1);
    setEventChats(db, 1, [CHAT]);
    const { probe } = probeFor({}, [], { [CHAT]: OTHER });

    await refreshMemberships(db, probe, 3, [CHAT], now);

    expect(chatsOfEvent(db, 1)).toEqual([OTHER]);
    expect(canSeeEvent(db, 1, 3)).toBe(false);
  });

  test("restricting an event afterwards leaves existing registrations visible and cancelable", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    setEventChats(db, 1, [CHAT]);

    expect(canSeeEvent(db, 1, 2)).toBe(true);
    cancelRegistration(db, 1, 2, now);
    // Once cancelled the exemption lapses, so a non-member cannot slip back in.
    expect(canSeeEvent(db, 1, 2)).toBe(false);
    expect(joinEvent(db, 1, 2, now)).toEqual({ error: "not_eligible" });
  });

  test("assignments replace rather than accumulate, and drive the refresh set", () => {
    event(1);
    setEventChats(db, 1, [OTHER, CHAT, CHAT]);
    expect(chatsOfEvent(db, 1)).toEqual([OTHER, CHAT].sort((a, b) => a - b));
    expect(chatsGatingUpcomingEvents(db, now).sort((a, b) => a - b)).toEqual([OTHER, CHAT].sort((a, b) => a - b));

    setEventChats(db, 1, []);
    expect(chatsOfEvent(db, 1)).toEqual([]);
    expect(chatsGatingUpcomingEvents(db, now)).toEqual([]);
  });
});
