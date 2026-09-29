import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate } from "../packages/db/src";

import { presenceOf, pruneChats, type BotPresence } from "./prune-chats";

const GONE: BotPresence = { kind: "gone", reason: "kicked" };
const HERE: BotPresence = { kind: "present" };

describe("reading Telegram's answer about the bot", () => {
  test("members, admins and unrestricted members are present", () => {
    for (const status of ["creator", "administrator", "member"]) {
      expect(presenceOf({ ok: true, result: { status } }).kind).toBe("present");
    }
    expect(presenceOf({ ok: true, result: { status: "restricted", is_member: true } }).kind).toBe("present");
  });

  test("left, kicked and restricted-but-out are gone", () => {
    for (const status of ["left", "kicked"]) expect(presenceOf({ ok: true, result: { status } }).kind).toBe("gone");
    expect(presenceOf({ ok: true, result: { status: "restricted", is_member: false } }).kind).toBe("gone");
  });

  test("403 and chat-not-found are gone", () => {
    expect(presenceOf({ ok: false, error_code: 403, description: "Forbidden: bot was kicked from the supergroup chat" }).kind).toBe("gone");
    expect(presenceOf({ ok: false, error_code: 400, description: "Bad Request: chat not found" }).kind).toBe("gone");
  });

  test("an upgraded group is not gone", () => {
    expect(presenceOf({
      ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: -1002 },
    })).toEqual({ kind: "upgraded", movedTo: -1002 });
  });

  test("anything else is unknown, never gone", () => {
    expect(presenceOf({ ok: false, error_code: 429, description: "Too Many Requests: retry after 5" }).kind).toBe("unknown");
    expect(presenceOf({ ok: false, error_code: 400, description: "Bad Request: something new" }).kind).toBe("unknown");
    expect(presenceOf({ ok: false, error_code: 500, description: "Internal Server Error" }).kind).toBe("unknown");
  });
});

describe("pruning the chat catalog", () => {
  let db: Database;
  const chatIds = () => db.query<{ id: number }, []>("SELECT id FROM chats ORDER BY id").all().map((row) => row.id);
  const count = (sql: string) => db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${sql}`).get()?.n;

  const event = (id: number, gates: number[], endedAt: number | null = null) => {
    db.query("INSERT INTO events (id, title, description, starts_at, location, created_by, ended_at) VALUES (?, ?, '', 0, 'Park', 1, ?)")
      .run(id, `Run ${id}`, endedAt);
    for (const chatId of gates) db.query("INSERT INTO event_chats (event_id, chat_id) VALUES (?, ?)").run(id, chatId);
  };

  beforeEach(() => {
    const drizzle = createDb(":memory:");
    migrate(drizzle);
    db = drizzle.$client;
    db.run("INSERT INTO users (id, first_name) VALUES (1, 'Admin'), (2, 'Guest')");
    for (const id of [-1, -2, -3, -4]) db.query("INSERT INTO chats (id, city, title) VALUES (?, 'msk', ?)").run(id, `Chat ${id}`);
  });

  test("preview changes nothing", async () => {
    const report = await pruneChats(db, async () => GONE, false);
    expect(report.forgotten.map((chat) => chat.id)).toEqual([-4, -3, -2, -1]);
    expect(chatIds()).toEqual([-4, -3, -2, -1]);
  });

  test("forgets only the chats the bot is clearly out of", async () => {
    const answers: Record<number, BotPresence> = {
      [-1]: HERE,
      [-2]: GONE,
      [-3]: { kind: "unknown", reason: "429" },
      [-4]: { kind: "upgraded", movedTo: -40 },
    };
    const report = await pruneChats(db, async (chatId) => answers[chatId] ?? HERE, true);
    expect(report.forgotten.map((chat) => chat.id)).toEqual([-2]);
    expect(report.unknown.map((chat) => chat.id)).toEqual([-3]);
    expect(report.upgraded.map((chat) => chat.id)).toEqual([-4]);
    expect(chatIds()).toEqual([-4, -3, -1]);
  });

  test("drops every safe reference along with the chat", async () => {
    event(10, [-1, -2]);
    db.run("UPDATE events SET home_chat_id = -2 WHERE id = 10");
    db.run("INSERT INTO chat_members (chat_id, user_id, is_member, checked_at) VALUES (-2, 2, 1, 0), (-1, 2, 1, 0)");
    db.run("INSERT INTO chat_guests (chat_id, user_id, event_id, invite_link) VALUES (-2, 2, 10, 'https://t.me/+x')");

    await pruneChats(db, async (chatId) => (chatId === -2 ? GONE : HERE), true);

    expect(chatIds()).toEqual([-4, -3, -1]);
    expect(db.query("SELECT chat_id FROM event_chats WHERE event_id = 10").all()).toEqual([{ chat_id: -1 }]);
    expect(db.query("SELECT home_chat_id FROM events WHERE id = 10").get()).toEqual({ home_chat_id: null });
    expect(count("chat_members WHERE chat_id = -2")).toBe(0);
    expect(count("chat_members WHERE chat_id = -1")).toBe(1);
    expect(count("chat_guests")).toBe(0);
  });

  test("never opens a live event to everyone by removing its last gate", async () => {
    event(10, [-2]);
    const report = await pruneChats(db, async (chatId) => (chatId === -2 ? GONE : HERE), true);
    expect(report.blocked.map((chat) => chat.id)).toEqual([-2]);
    expect(report.blocked[0]?.blockers).toEqual([{ kind: "event", id: 10, title: "Run 10" }]);
    expect(chatIds()).toEqual([-4, -3, -2, -1]);
    expect(count("event_chats")).toBe(1);
  });

  test("an ended event's last gate stays as history and does not block", async () => {
    event(10, [-2], 100);
    await pruneChats(db, async (chatId) => (chatId === -2 ? GONE : HERE), true);
    expect(chatIds()).toEqual([-4, -3, -1]);
    expect(db.query("SELECT chat_id FROM event_chats WHERE event_id = 10").all()).toEqual([{ chat_id: -2 }]);
  });

  test("a series gated only by the chat blocks it too", async () => {
    db.run("INSERT INTO event_series (id, city, title, description, location, created_by) VALUES (5, 'msk', 'Weekly', '', 'Park', 1)");
    db.run("INSERT INTO series_chats (series_id, chat_id) VALUES (5, -2)");
    const report = await pruneChats(db, async (chatId) => (chatId === -2 ? GONE : HERE), true);
    expect(report.blocked[0]?.blockers).toEqual([{ kind: "series", id: 5, title: "Weekly" }]);
    expect(chatIds()).toContain(-2);
  });
});
