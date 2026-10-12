process.env.BOT_TOKEN = "12345:draft-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001";
process.env.WEBHOOK_SECRET = "webhook";
process.env.CHECKIN_SECRET = "checkin";
process.env.DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "test";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { draftHandler } = await import("../../src/bot/drafts");
const { draftCallback } = await import("../../src/bot/callbacks");
const { spawnDueSeries } = await import("../../src/sweeper");
const { dispatchEffects } = await import("../../src/notify");
const { runtime } = await import("../../src/runtime");
const { bot } = await import("../../src/bot");
const { db } = await import("../../src/db");

type Markup = { toJSON(): unknown } | undefined;
const labels = (markup: Markup) => markup
  ? (markup.toJSON() as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard.flat().map((button) => button.text)
  : [];

const sent: Array<{ chat_id: number; text: string; buttons: string[] }> = [];
const LEAD = 1;
const BRANCH_ADMIN = 2;
const RUNNER = 3;
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

/** A callback query as gramio hands it over, recording what the bot does with the message. */
const tap = (userId: number, data: string) => {
  const calls = { edits: [] as Array<{ text: string; markup: Markup }>, markups: [] as Markup[] };
  return {
    calls,
    context: {
      data,
      from: { id: userId, languageCode: "en" },
      answer: async () => true as const,
      editText: async (text: string | { toString(): string }, params?: { reply_markup?: Markup }) => { calls.edits.push({ text: String(text), markup: params?.reply_markup }); },
      editReplyMarkup: async (markup: Markup) => { calls.markups.push(markup); },
    },
  };
};
const status = (eventId: number) => db.$client.query<{ status: string }, [number]>("SELECT status FROM events WHERE id = ?").get(eventId)?.status;

/** The suites share one database: leave nothing behind that a later `DELETE FROM users` would trip on. */
const clear = () => {
  for (const table of ["refunds", "payment_attempts", "ticket_orders", "event_organizers", "registrations", "events", "series_organizers", "event_series", "user_city_roles", "users"]) {
    db.$client.query(`DELETE FROM ${table}`).run();
  }
};

describe("series drafts and failed refunds in chat", () => {
  afterEach(clear);
  beforeEach(() => {
    sent.length = 0;
    Object.assign(bot.api, {
      sendMessage: async (params: { chat_id: number; text: unknown; reply_markup?: Markup }) => {
        sent.push({ chat_id: params.chat_id, text: String(params.text), buttons: labels(params.reply_markup) });
        return { message_id: sent.length };
      },
    });
    clear();
    db.$client.run(`
      INSERT INTO users (id, first_name, locale) VALUES (${LEAD}, 'Lead', 'en'), (${BRANCH_ADMIN}, 'Admin', 'en');
      INSERT INTO users (id, first_name, last_name, username, locale) VALUES (${RUNNER}, 'Ann', 'Runner', 'annruns', 'en');
      INSERT INTO user_city_roles (city, user_id, role) VALUES ('spb', ${BRANCH_ADMIN}, 'admin');
    `);
  });

  /** A weekly series whose next run is due to be raised now. */
  const raiseDraft = async () => {
    const series = db.$client.query<{ id: number }, [number]>(`
      INSERT INTO event_series (city, title, description, location, capacity, next_starts_at, created_by)
      VALUES ('spb', 'Track night', 'Intervals', 'Stadium', 20, ?, ${LEAD}) RETURNING id
    `).get(unix(new Date(Date.now() + 86_400_000)))!;
    db.$client.query(`INSERT INTO series_organizers (series_id, user_id) VALUES (?, ${LEAD})`).run(series.id);
    await runtime.runPromise(spawnDueSeries(new Date()));
    return db.$client.query<{ id: number }, [number]>("SELECT id FROM events WHERE series_id = ?").get(series.id)!.id;
  };

  test("the hourly sweep announces a raised draft: buttons for the admin, a link for the lead", async () => {
    const eventId = await raiseDraft();
    expect(status(eventId)).toBe("draft");
    expect(sent.map(({ chat_id, buttons }) => ({ chat_id, buttons }))).toEqual([
      { chat_id: LEAD, buttons: ["Open draft"] },
      { chat_id: BRANCH_ADMIN, buttons: ["✅ Publish", "Skip this run", "Open draft"] },
    ]);
    expect(sent[0]?.text).toContain("Track night");
  });

  test("an admin publishes from chat; a second tap finds it already handled", async () => {
    const eventId = await raiseDraft();
    const publish = tap(BRANCH_ADMIN, draftCallback.pack({ id: eventId, step: "publish" }));
    await draftHandler(publish.context);
    expect(status(eventId)).toBe("published");
    expect(publish.calls.edits[0]?.text).toContain("Published");
    expect(labels(publish.calls.edits[0]?.markup)).toEqual(["Open draft"]);

    const again = tap(BRANCH_ADMIN, draftCallback.pack({ id: eventId, step: "publish" }));
    await draftHandler(again.context);
    expect(again.calls.edits[0]?.text).toBe("This draft has already been published or removed.");
  });

  test("a lead without branch rights cannot publish, even with a crafted button", async () => {
    const eventId = await raiseDraft();
    const publish = tap(LEAD, draftCallback.pack({ id: eventId, step: "publish" }));
    await draftHandler(publish.context);
    expect(status(eventId)).toBe("draft");
    expect(publish.calls.edits[0]?.text).toContain("Only the branch's admins");
  });

  test("skipping asks first, can be taken back, and then deletes the draft", async () => {
    const eventId = await raiseDraft();
    const skip = tap(BRANCH_ADMIN, draftCallback.pack({ id: eventId, step: "skip" }));
    await draftHandler(skip.context);
    expect(labels(skip.calls.markups[0])).toEqual(["Yes, delete this draft", "Keep it"]);

    const back = tap(BRANCH_ADMIN, draftCallback.pack({ id: eventId, step: "back" }));
    await draftHandler(back.context);
    expect(labels(back.calls.markups[0])).toEqual(["✅ Publish", "Skip this run", "Open draft"]);
    expect(status(eventId)).toBe("draft");

    const confirm = tap(BRANCH_ADMIN, draftCallback.pack({ id: eventId, step: "confirm" }));
    await draftHandler(confirm.context);
    expect(status(eventId)).toBeUndefined();
    expect(confirm.calls.edits[0]?.text).toContain("Skipped");
  });

  test("the refund alert names the run, the runner, the amount and the provider's reason", async () => {
    db.$client.run(`
      INSERT INTO events (id, city, title, description, starts_at, location, capacity, status, created_by)
        VALUES (50, 'spb', 'Paid run', '', ${unix(new Date(Date.now() + 86_400_000))}, 'Park', 5, 'published', ${LEAD});
      INSERT INTO ticket_orders (id, event_id, user_id, ticket_name, amount_minor, status, expires_at)
        VALUES ('order-1', 50, ${RUNNER}, 'Standard', 150000, 'refund_failed', 0);
      INSERT INTO payment_attempts (id, order_id, idempotence_key, status) VALUES ('attempt-1', 'order-1', 'pay-key-1', 'succeeded');
      INSERT INTO refunds (id, order_id, payment_attempt_id, idempotence_key, amount_minor, status, reason, failure_reason)
        VALUES ('refund-1', 'order-1', 'attempt-1', 'key-1', 150000, 'canceled', 'admin', 'Refunds are restricted for this shop');
      -- A retry already under way by the time the alert goes out must not rewrite it.
      INSERT INTO refunds (id, order_id, payment_attempt_id, idempotence_key, amount_minor, status, reason)
        VALUES ('refund-2', 'order-1', 'attempt-1', 'key-2', 150000, 'pending', 'admin');
    `);
    await runtime.runPromise(dispatchEffects([{ kind: "refund_failed_alert", userId: BRANCH_ADMIN, eventId: 50, orderId: "order-1", runnerId: RUNNER, reason: "Refunds are restricted for this shop" }]));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: BRANCH_ADMIN, buttons: ["Open the app"] });
    for (const part of ["Paid run", "Ann Runner (@annruns)", "1,500", "Refunds are restricted for this shop"]) expect(sent[0]?.text).toContain(part);
  });
});
