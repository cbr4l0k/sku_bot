process.env.BOT_TOKEN = "12345:reminder-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001";
process.env.WEBHOOK_SECRET = "webhook";
process.env.CHECKIN_SECRET = "checkin";
process.env.DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "test";

import { beforeEach, describe, expect, test } from "bun:test";

const { dispatchEffects } = await import("../../src/notify");
const { runtime } = await import("../../src/runtime");
const { bot } = await import("../../src/bot");
const { db } = await import("../../src/db");

type Sent = { chat_id: number; text: string; buttons: string[] };
const sent: Sent[] = [];

describe("the reminder DM", () => {
  beforeEach(() => {
    sent.length = 0;
    Object.assign(bot.api, {
      sendMessage: async (params: { chat_id: number; text: unknown; reply_markup?: { toJSON(): unknown } }) => {
        const rows = (params.reply_markup?.toJSON() as { inline_keyboard: Array<Array<{ text: string }>> } | undefined)?.inline_keyboard ?? [];
        sent.push({ chat_id: params.chat_id, text: String(params.text), buttons: rows.flat().map((button) => button.text) });
        return { message_id: sent.length };
      },
    });
    db.$client.query("DELETE FROM ticket_tiers").run();
    db.$client.query("DELETE FROM events").run();
    db.$client.query("DELETE FROM users").run();
    db.$client.query("INSERT INTO users (id, first_name, locale) VALUES (1, 'U1', 'en')").run();
    db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, created_by) VALUES (1, 'Track night', 'x', ?, 'Stadium', 2, 'published', 1)")
      .run(Math.floor(Date.now() / 1000) + 3600);
  });

  test("names the run and offers a way out of a free one", async () => {
    await runtime.runPromise(dispatchEffects([{ kind: "run_reminder", userId: 1, eventId: 1 }]));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: 1, buttons: ["Can't make it", "Open event"] });
    expect(sent[0]?.text).toContain("Track night");
    expect(sent[0]?.text).toContain("Stadium");
  });

  test("a paid run is only opened, never left from chat", async () => {
    db.$client.query("INSERT INTO ticket_tiers (event_id, name, price_minor, quota) VALUES (1, 'Standard', 100000, 2)").run();
    await runtime.runPromise(dispatchEffects([{ kind: "run_reminder", userId: 1, eventId: 1 }]));
    expect(sent[0]?.buttons).toEqual(["Open event"]);
  });
});
