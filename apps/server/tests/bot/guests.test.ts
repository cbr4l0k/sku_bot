process.env.BOT_TOKEN = "12345:guest-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001";
process.env.WEBHOOK_SECRET = "webhook";
process.env.CHECKIN_SECRET = "checkin";
process.env.DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "test";

import { beforeEach, describe, expect, test } from "bun:test";

const { syncChatGuests } = await import("../../src/bot/guests");
const { SETTLEMENT_GRACE_MS } = await import("../../src/core/guests");
const { MEMBERSHIP_TTL_MS } = await import("../../src/core/membership");
const { checkIn } = await import("../../src/core/checkin");
const { joinEvent } = await import("../../src/core/registration");
const { endEvent } = await import("../../src/core/waitlist");
const { bot } = await import("../../src/bot");
const { db } = await import("../../src/db");

const CHAT = -1001234567890;
const now = new Date("2030-06-01T09:00:00Z");
const afterEvent = new Date(now.getTime() + 3 * 3_600_000);
const afterGrace = new Date(afterEvent.getTime() + SETTLEMENT_GRACE_MS + 1_000);
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

type Calls = {
  invitesFor: number[];
  messagedUsers: number[];
  bannedUsers: number[];
  unbannedUsers: number[];
  revokedLinks: string[];
  memberLookups: number;
};

/**
 * Stands in for the whole Bot API. `members` is who Telegram places in the chat;
 * `unreachable` makes getChatMember throw, the case where we must not guess.
 */
const stubBot = (members: number[], unreachable = false): Calls => {
  const calls: Calls = { invitesFor: [], messagedUsers: [], bannedUsers: [], unbannedUsers: [], revokedLinks: [], memberLookups: 0 };
  const present = new Set(members);

  Object.assign(bot.api, {
    getChatMember: async ({ user_id }: { user_id: number }) => {
      calls.memberLookups += 1;
      if (unreachable) throw new Error("Bad Request: member list is inaccessible");
      return { status: present.has(user_id) ? "member" : "left" };
    },
    createChatInviteLink: async ({ name }: { name: string }) => {
      const userId = Number(/u(\d+)$/.exec(name)?.[1] ?? 0);
      calls.invitesFor.push(userId);
      return { invite_link: `https://t.me/+link-u${userId}` };
    },
    sendMessage: async ({ chat_id }: { chat_id: number }) => {
      calls.messagedUsers.push(chat_id);
      return { message_id: 1 };
    },
    revokeChatInviteLink: async ({ invite_link }: { invite_link: string }) => {
      calls.revokedLinks.push(invite_link);
      return { invite_link };
    },
    banChatMember: async ({ user_id }: { user_id: number }) => {
      calls.bannedUsers.push(user_id);
      present.delete(user_id);
      return true;
    },
    unbanChatMember: async ({ user_id }: { user_id: number }) => {
      calls.unbannedUsers.push(user_id);
      return true;
    },
  });

  return calls;
};

const event = (id: number, homeChat: number | null = CHAT) => {
  db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, home_chat_id, created_by) VALUES (?, 'run', 'x', ?, 'park', NULL, 'published', ?, 1)")
    .run(id, unix(new Date(now.getTime() + 86_400_000)), homeChat);
  return id;
};

const guestRow = (userId: number) => db.$client
  .query<{ status: string }, [number, number]>("SELECT status FROM chat_guests WHERE chat_id = ? AND user_id = ?")
  .get(CHAT, userId);

describe("chat guest sync", () => {
  beforeEach(() => {
    for (const table of ["chat_guests", "chat_members", "registrations", "event_chats", "events", "users"]) {
      db.$client.query(`DELETE FROM ${table}`).run();
    }
    for (let id = 1; id <= 4; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
  });

  test("an outsider is sent a single-use link and put on trial", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    const calls = stubBot([]);

    await syncChatGuests(db, now);

    expect(calls.invitesFor).toEqual([2]);
    expect(calls.messagedUsers).toEqual([2]);
    expect(guestRow(2)).toEqual({ status: "invited" });
  });

  test("someone already in the chat is left completely alone", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    const calls = stubBot([2]);

    await syncChatGuests(db, now);

    expect(calls.invitesFor).toEqual([]);
    expect(calls.messagedUsers).toEqual([]);
    expect(guestRow(2)).toBeNull();

    // ...and having settled that once, they are not looked up again on every pass.
    await syncChatGuests(db, now);
    expect(calls.memberLookups).toBe(1);
  });

  test("someone who leaves the chat is invited back once the cached answer goes stale", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    const inChat = stubBot([2]);
    await syncChatGuests(db, now);
    expect(inChat.invitesFor).toEqual([]);

    // They leave. Until the cached "member" answer expires, the sweep still believes it.
    const left = stubBot([]);
    await syncChatGuests(db, new Date(now.getTime() + MEMBERSHIP_TTL_MS - 1_000));
    expect(left.invitesFor).toEqual([]);

    await syncChatGuests(db, new Date(now.getTime() + MEMBERSHIP_TTL_MS + 1_000));
    expect(left.invitesFor).toEqual([2]);
    expect(guestRow(2)).toEqual({ status: "invited" });
  });

  test("an existing member is never removed, because no trial was ever opened on them", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    stubBot([2]);
    await syncChatGuests(db, now);

    // They skip the run entirely, and the event is ended and swept.
    endEvent(db, 1, afterEvent);
    const settle = stubBot([2]);
    await syncChatGuests(db, afterGrace);

    expect(settle.bannedUsers).toEqual([]);
    expect(guestRow(2)).toBeNull();
  });

  test("a guest who never checks in is kicked without being banned", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    const calls = stubBot([]);
    await syncChatGuests(db, now);

    // They take the invite, then never turn up.
    stubBot([2]);
    endEvent(db, 1, afterEvent);
    const settle = stubBot([2]);
    await syncChatGuests(db, afterGrace);

    expect(settle.bannedUsers).toEqual([2]);
    expect(settle.unbannedUsers).toEqual([2]);
    expect(settle.revokedLinks).toEqual(["https://t.me/+link-u2"]);
    expect(guestRow(2)).toEqual({ status: "removed" });
    expect(calls.invitesFor).toEqual([2]);
  });

  test("a guest who checks in keeps their place", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    stubBot([]);
    await syncChatGuests(db, now);
    expect(checkIn(db, 1, 2, now)).toEqual({ ok: true });

    endEvent(db, 1, afterEvent);
    const settle = stubBot([2]);
    await syncChatGuests(db, afterGrace);

    expect(settle.bannedUsers).toEqual([]);
    expect(guestRow(2)).toEqual({ status: "kept" });
  });

  test("nothing is removed inside the grace window, so the roster can still be fixed", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    stubBot([]);
    await syncChatGuests(db, now);

    endEvent(db, 1, afterEvent);
    const settle = stubBot([2]);
    await syncChatGuests(db, afterEvent);
    expect(settle.bannedUsers).toEqual([]);

    // The organizer marks them present by hand before the window closes.
    db.$client.query("UPDATE registrations SET status = 'checked_in' WHERE event_id = 1 AND user_id = 2").run();
    await syncChatGuests(db, afterGrace);
    expect(settle.bannedUsers).toEqual([]);
    expect(guestRow(2)).toEqual({ status: "kept" });
  });

  test("an unanswerable chat invites nobody rather than guessing they are outside", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    const calls = stubBot([], true);

    await syncChatGuests(db, now);

    expect(calls.invitesFor).toEqual([]);
    expect(guestRow(2)).toBeNull();
  });

  test("a failed invite DM leaves no trial behind and revokes the unused link", async () => {
    event(1);
    joinEvent(db, 1, 2, now);
    const calls = stubBot([]);
    const { TelegramError } = await import("gramio");
    Object.assign(bot.api, {
      sendMessage: async () => new TelegramError(
        { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
        "sendMessage",
        { chat_id: 2, text: "" },
      ),
    });

    await syncChatGuests(db, now);

    expect(calls.invitesFor).toEqual([2]);
    expect(calls.revokedLinks).toEqual(["https://t.me/+link-u2"]);
    expect(guestRow(2)).toBeNull();
  });

  test("an event with no home chat invites nobody at all", async () => {
    event(1, null);
    joinEvent(db, 1, 2, now);
    const calls = stubBot([]);

    await syncChatGuests(db, now);

    expect(calls.memberLookups).toBe(0);
    expect(calls.invitesFor).toEqual([]);
  });
});
