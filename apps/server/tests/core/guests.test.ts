import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import {
  SETTLEMENT_GRACE_MS,
  eventsAwaitingSettlement,
  inviteCandidates,
  settleTrials,
  startTrial,
} from "../../src/core/guests";
import { checkIn } from "../../src/core/checkin";
import { joinEvent } from "../../src/core/registration";
import { endEvent, reopenEvent } from "../../src/core/waitlist";

describe("chat guests", () => {
  let db: Db;
  const now = new Date("2030-01-01T12:00:00Z");
  const later = new Date(now.getTime() + 3 * 3_600_000);
  /** Past the point where an ended event's trials are ripe for settling. */
  const settleTime = new Date(later.getTime() + SETTLEMENT_GRACE_MS + 1_000);
  const unix = (date: Date) => Math.floor(date.getTime() / 1000);
  const CHAT = -1001234567890;
  const OTHER = -1009876543210;

  /** A published, unfinished event; `homeChat` null leaves it with nowhere to invite anyone. */
  const event = (id: number, homeChat: number | null = CHAT, startsAt = new Date(now.getTime() + 86_400_000)) => {
    db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, home_chat_id, created_by) VALUES (?, 'run', 'x', ?, 'park', NULL, 'published', ?, 1)")
      .run(id, unix(startsAt), homeChat);
    return id;
  };

  const invite = (eventId: number, userId: number, chatId = CHAT) =>
    startTrial(db, { eventId, chatId, userId }, `https://t.me/+link${eventId}-${userId}`, now);

  const guestRow = (userId: number, chatId = CHAT) => db.$client
    .query<{ event_id: number; status: string; settled_at: number | null }, [number, number]>(
      "SELECT event_id, status, settled_at FROM chat_guests WHERE chat_id = ? AND user_id = ?",
    )
    .get(chatId, userId);

  const candidateIds = () => inviteCandidates(db).map((candidate) => candidate.userId);

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db);
    for (let id = 1; id <= 5; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
  });

  test("everyone holding a spot at an event with a home chat is a candidate", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    joinEvent(db, 1, 3, now);
    expect(inviteCandidates(db)).toEqual([
      { eventId: 1, chatId: CHAT, userId: 2 },
      { eventId: 1, chatId: CHAT, userId: 3 },
    ]);
  });

  test("an event with no home chat invites nobody", () => {
    event(1, null);
    joinEvent(db, 1, 2, now);
    expect(inviteCandidates(db)).toEqual([]);
  });

  test("setting a home chat later picks up people who already signed up", () => {
    event(1, null);
    joinEvent(db, 1, 2, now);
    expect(candidateIds()).toEqual([]);

    db.$client.query("UPDATE events SET home_chat_id = ? WHERE id = 1").run(CHAT);
    expect(candidateIds()).toEqual([2]);
  });

  test("the queue, the banned, and ended events are all left out", () => {
    event(1);
    db.$client.query("UPDATE events SET capacity = 1 WHERE id = 1").run();
    joinEvent(db, 1, 2, now);
    expect(joinEvent(db, 1, 3, now)).toMatchObject({ status: "waitlisted" });
    expect(candidateIds()).toEqual([2]);

    db.$client.query("UPDATE users SET is_banned = 1 WHERE id = 2").run();
    expect(candidateIds()).toEqual([]);

    db.$client.query("UPDATE users SET is_banned = 0 WHERE id = 2").run();
    endEvent(db, 1, later);
    expect(candidateIds()).toEqual([]);
  });

  test("a trial is issued once and not offered again while it runs", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    invite(1, 2);
    expect(candidateIds()).toEqual([]);
    expect(guestRow(2)).toMatchObject({ event_id: 1, status: "invited", settled_at: null });
  });

  test("checking in turns the trial into a place they keep", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    invite(1, 2);
    expect(checkIn(db, 1, 2, now)).toEqual({ ok: true });

    endEvent(db, 1, later);
    expect(settleTrials(db, 1, settleTime)).toEqual([
      { chatId: CHAT, userId: 2, inviteLink: "https://t.me/+link1-2", carriedTo: null, keep: true },
    ]);
    expect(guestRow(2)).toMatchObject({ status: "kept", settled_at: unix(settleTime) });
  });

  test("a no-show is removed when the event ends", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    invite(1, 2);

    endEvent(db, 1, later);
    expect(settleTrials(db, 1, settleTime)).toEqual([
      { chatId: CHAT, userId: 2, inviteLink: "https://t.me/+link1-2", carriedTo: null, keep: false },
    ]);
    expect(guestRow(2)).toMatchObject({ status: "removed", settled_at: unix(settleTime) });
  });

  test("someone who was already in the chat is never on trial, so is never removed", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    // No startTrial: the bot found them inside the chat already and wrote nothing down.
    endEvent(db, 1, later);
    expect(settleTrials(db, 1, settleTime)).toEqual([]);
    expect(guestRow(2)).toBeNull();
  });

  test("a no-show with another run booked carries the trial over instead of settling it", () => {
    event(1);
    event(2, CHAT, new Date(now.getTime() + 3 * 86_400_000));
    joinEvent(db, 1, 2, now);
    joinEvent(db, 2, 2, now);
    invite(1, 2);

    endEvent(db, 1, later);
    expect(settleTrials(db, 1, settleTime)).toEqual([
      { chatId: CHAT, userId: 2, inviteLink: "https://t.me/+link1-2", carriedTo: 2, keep: false },
    ]);
    // Still on trial, now answering to the second run — and not re-invited in the meantime.
    expect(guestRow(2)).toMatchObject({ event_id: 2, status: "invited", settled_at: null });
    expect(candidateIds()).toEqual([]);

    // Skipping that one too finally removes them.
    endEvent(db, 2, later);
    expect(settleTrials(db, 2, settleTime)).toMatchObject([{ userId: 2, carriedTo: null, keep: false }]);
    expect(guestRow(2)).toMatchObject({ status: "removed" });
  });

  test("a run into a different chat does not rescue a no-show", () => {
    event(1);
    event(2, OTHER);
    joinEvent(db, 1, 2, now);
    joinEvent(db, 2, 2, now);
    invite(1, 2);

    endEvent(db, 1, later);
    expect(settleTrials(db, 1, settleTime)).toMatchObject([{ chatId: CHAT, userId: 2, carriedTo: null, keep: false }]);
  });

  test("a removed guest who books again starts a fresh trial", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    invite(1, 2);
    endEvent(db, 1, later);
    settleTrials(db, 1, settleTime);

    event(2);
    joinEvent(db, 2, 2, settleTime);
    expect(inviteCandidates(db)).toEqual([{ eventId: 2, chatId: CHAT, userId: 2 }]);

    invite(2, 2);
    expect(guestRow(2)).toMatchObject({ event_id: 2, status: "invited", settled_at: null });
  });

  test("ended and canceled events queue up for settlement, and only until settled", () => {
    event(1);
    event(2);
    joinEvent(db, 1, 2, now);
    joinEvent(db, 2, 3, now);
    invite(1, 2);
    invite(2, 3);
    expect(eventsAwaitingSettlement(db, settleTime)).toEqual([]);

    endEvent(db, 1, later);
    db.$client.query("UPDATE events SET status = 'canceled' WHERE id = 2").run();
    expect(eventsAwaitingSettlement(db, settleTime).sort()).toEqual([1, 2]);

    settleTrials(db, 1, settleTime);
    expect(eventsAwaitingSettlement(db, settleTime)).toEqual([2]);
    settleTrials(db, 2, settleTime);
    expect(eventsAwaitingSettlement(db, settleTime)).toEqual([]);
  });

  test("an ended event holds off long enough for the roster to be corrected", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    invite(1, 2);
    endEvent(db, 1, later);

    // Straight after the organizer taps "end", nothing is removable yet.
    expect(eventsAwaitingSettlement(db, later)).toEqual([]);
    expect(eventsAwaitingSettlement(db, new Date(later.getTime() + SETTLEMENT_GRACE_MS - 1_000))).toEqual([]);
    expect(eventsAwaitingSettlement(db, settleTime)).toEqual([1]);
  });

  test("leaving 'published' settles at once, whichever way it happens", () => {
    for (const [id, status] of [[1, "canceled"], [2, "closed"], [3, "draft"]] as const) {
      event(id);
      joinEvent(db, id, 2, now);
      invite(id, 2);
      expect(eventsAwaitingSettlement(db, now)).toEqual([]);

      db.$client.query("UPDATE events SET status = ? WHERE id = ?").run(status, id);
      expect(eventsAwaitingSettlement(db, now)).toEqual([id]);

      settleTrials(db, id, now);
    }
  });

  test("reopening an event inside the grace window calls the removal off", () => {
    event(1);
    joinEvent(db, 1, 2, now);
    invite(1, 2);
    endEvent(db, 1, later);
    reopenEvent(db, 1, later);

    expect(eventsAwaitingSettlement(db, settleTime)).toEqual([]);
    expect(guestRow(2)).toMatchObject({ status: "invited", settled_at: null });
  });
});
