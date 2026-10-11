process.env.BOT_TOKEN = "12345:leave-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001";
process.env.WEBHOOK_SECRET = "webhook";
process.env.CHECKIN_SECRET = "checkin";
process.env.DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "test";

import { beforeEach, describe, expect, test } from "bun:test";
import { run } from "../support/effect";

const { declineHandler, leaveHandler } = await import("../../src/bot/leave");
const { offerHandler } = await import("../../src/bot/offers");
const { sweepOffers } = await import("../../src/core/waitlist");
const { declineCallback, leaveCallback, offerCallback } = await import("../../src/bot/callbacks");
const { cancelRegistration, joinEvent } = await import("../../src/core/registration");
const { bot } = await import("../../src/bot");
const { db } = await import("../../src/db");

const now = new Date();
const unix = (date: Date) => Math.floor(date.getTime() / 1000);
const status = (userId: number) => db.$client.query<{ status: string }, [number]>("SELECT status FROM registrations WHERE event_id = 1 AND user_id = ?").get(userId)?.status;
const offers = () => db.$client.query<{ id: number; user_id: number; status: string }, []>("SELECT id, user_id, status FROM waitlist_offers ORDER BY id").all();

type Markup = { toJSON(): unknown } | undefined;
/** A callback query as gramio hands it over, recording what the bot does with the message. */
const tap = (userId: number, data: string) => {
  const calls = { edits: [] as Array<{ text: string; markup: Markup }>, markups: [] as Markup[], sent: [] as string[] };
  return {
    calls,
    context: {
      data,
      from: { id: userId, languageCode: "en" },
      answer: async () => true as const,
      editText: async (text: string | { toString(): string }, params?: { reply_markup?: Markup }) => { calls.edits.push({ text: String(text), markup: params?.reply_markup }); },
      editReplyMarkup: async (markup: Markup) => { calls.markups.push(markup); },
      send: async (text: string | { toString(): string }) => { calls.sent.push(String(text)); },
    },
  };
};
const labels = (markup: Markup) => markup
  ? (markup.toJSON() as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard.flat().map((button) => button.text)
  : [];

const dms: Array<{ chat_id: number; text: string }> = [];

describe("leaving from chat", () => {
  beforeEach(() => {
    dms.length = 0;
    Object.assign(bot.api, {
      sendMessage: async (params: { chat_id: number; text: unknown }) => {
        dms.push({ chat_id: params.chat_id, text: String(params.text) });
        return { message_id: dms.length };
      },
      editMessageReplyMarkup: async () => true,
    });
    db.$client.query("DELETE FROM waitlist_offers").run();
    db.$client.query("DELETE FROM registrations").run();
    db.$client.query("DELETE FROM ticket_tiers").run();
    db.$client.query("DELETE FROM events").run();
    db.$client.query("DELETE FROM users").run();
    for (let id = 1; id <= 3; id++) db.$client.query("INSERT INTO users (id, first_name, locale) VALUES (?, ?, 'en')").run(id, `U${id}`);
    db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, created_by) VALUES (1, 'run', 'x', ?, 'park', 1, 'published', 1)")
      .run(unix(new Date(now.getTime() + 86_400_000)));
  });

  test("the first tap only asks; keeping it changes nothing", async () => {
    run(db, joinEvent(1, 1, now));
    const ask = tap(1, leaveCallback.pack({ id: 1, step: "ask" }));
    await leaveHandler(ask.context);
    expect(labels(ask.calls.markups[0])).toEqual(["Yes, give up my spot", "No, keep it"]);

    const back = tap(1, leaveCallback.pack({ id: 1, step: "back" }));
    await leaveHandler(back.context);
    expect(status(1)).toBe("registered");
    expect(labels(back.calls.edits[0]?.markup)).toContain("Can't make it");
  });

  test("confirming frees the spot and offers it to the head of the queue", async () => {
    run(db, joinEvent(1, 1, now));
    run(db, joinEvent(1, 2, now));
    const confirm = tap(1, leaveCallback.pack({ id: 1, step: "confirm" }));
    await leaveHandler(confirm.context);
    expect(status(1)).toBe("canceled");
    expect(confirm.calls.sent).toEqual(["You're off the list. Your spot goes to the next runner in the queue."]);
    expect(labels(confirm.calls.edits[0]?.markup)).toContain("✅ Sign up");
    expect(offers()).toMatchObject([{ user_id: 2, status: "pending" }]);
    expect(dms.map((dm) => dm.chat_id)).toEqual([2]);
  });

  test("a stale confirm on a paid event repaints the card instead of cancelling", async () => {
    run(db, joinEvent(1, 1, now));
    db.$client.query("INSERT INTO ticket_tiers (event_id, name, price_minor, quota) VALUES (1, 'Standard', 100000, 1)").run();
    const confirm = tap(1, leaveCallback.pack({ id: 1, step: "confirm" }));
    await leaveHandler(confirm.context);
    expect(status(1)).toBe("registered");
    expect(confirm.calls.sent).toEqual([]);
    expect(confirm.calls.edits).toHaveLength(1);
  });

  test("declining an offer leaves the queue and passes the spot on", async () => {
    run(db, joinEvent(1, 1, now));
    run(db, joinEvent(1, 2, now));
    run(db, joinEvent(1, 3, now));
    run(db, cancelRegistration(1, 1, now));
    const offer = offers()[0]!;

    const ask = tap(2, declineCallback.pack({ id: offer.id, step: "ask" }));
    await declineHandler(ask.context);
    expect(labels(ask.calls.markups[0])).toEqual(["Yes, pass it on and leave the queue", "Keep the offer"]);

    const back = tap(2, declineCallback.pack({ id: offer.id, step: "back" }));
    await declineHandler(back.context);
    expect(labels(back.calls.markups[0])).toEqual(["Accept", "Decline"]);

    const confirm = tap(2, declineCallback.pack({ id: offer.id, step: "confirm" }));
    await declineHandler(confirm.context);
    expect(status(2)).toBe("canceled");
    expect(confirm.calls.edits[0]?.text).toBe("Done — the spot goes to the next runner, and you've left the queue.");
    expect(offers()).toMatchObject([{ user_id: 2, status: "superseded" }, { user_id: 3, status: "pending" }]);
    expect(dms.at(-1)?.chat_id).toBe(3);
  });

  test("a stale Leave on an ended or canceled event cancels nothing and offers nothing", async () => {
    for (const close of ["UPDATE events SET ended_at = 1 WHERE id = 1", "UPDATE events SET status = 'canceled' WHERE id = 1"]) {
      db.$client.query("DELETE FROM waitlist_offers").run();
      db.$client.query("DELETE FROM registrations").run();
      db.$client.query("UPDATE events SET ended_at = NULL, status = 'published' WHERE id = 1").run();
      run(db, joinEvent(1, 1, now));
      run(db, joinEvent(1, 2, now));
      db.$client.query(close).run();
      await leaveHandler(tap(1, leaveCallback.pack({ id: 1, step: "confirm" })).context);
      expect(status(1)).toBe("registered");
      expect(offers()).toEqual([]);
    }
  });

  test("an offer for an event that has since gone paid cannot be declined into a lost ticket", async () => {
    run(db, joinEvent(1, 1, now));
    run(db, joinEvent(1, 2, now));
    run(db, cancelRegistration(1, 1, now));
    const offer = offers()[0]!;
    db.$client.query("INSERT INTO ticket_tiers (event_id, name, price_minor, quota) VALUES (1, 'Standard', 100000, 1)").run();
    const confirm = tap(2, declineCallback.pack({ id: offer.id, step: "confirm" }));
    await declineHandler(confirm.context);
    expect(status(2)).toBe("waitlisted");
    expect(confirm.calls.edits[0]?.text).toBe("This spot is no longer available.");
  });

  test("accepting withdraws the other open offers even when the chat edit fails", async () => {
    run(db, joinEvent(1, 1, now));
    run(db, joinEvent(1, 2, now));
    run(db, joinEvent(1, 3, now));
    run(db, cancelRegistration(1, 1, now));
    const first = offers()[0]!;
    // Lapsed and passed down the queue, yet still claimable by whoever answers first.
    db.$client.query("UPDATE waitlist_offers SET expires_at = ? WHERE id = ?").run(unix(now) - 1, first.id);
    run(db, sweepOffers(now));
    dms.length = 0;
    const accept = tap(2, offerCallback.pack({ id: first.id }));
    accept.context.editText = async () => { throw new Error("message to edit not found"); };
    await expect(offerHandler(accept.context)).rejects.toThrow();
    expect(status(2)).toBe("registered");
    expect(offers()).toMatchObject([{ user_id: 2, status: "accepted" }, { user_id: 3, status: "superseded" }]);
    expect(dms).toMatchObject([{ chat_id: 3, text: "This spot is no longer available." }]);
  });

  test("someone else's offer cannot be declined", async () => {
    run(db, joinEvent(1, 1, now));
    run(db, joinEvent(1, 2, now));
    run(db, cancelRegistration(1, 1, now));
    const offer = offers()[0]!;
    const confirm = tap(3, declineCallback.pack({ id: offer.id, step: "confirm" }));
    await declineHandler(confirm.context);
    expect(status(2)).toBe("waitlisted");
    expect(confirm.calls.edits[0]?.text).toBe("This spot is no longer available.");
  });
});
