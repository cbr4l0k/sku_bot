process.env.BOT_TOKEN = "12345:card-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001";
process.env.WEBHOOK_SECRET = "webhook";
process.env.CHECKIN_SECRET = "checkin";
process.env.DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "test";

import { beforeEach, describe, expect, test } from "bun:test";

const { renderEventCard } = await import("../../src/bot/event-card");
const { joinEvent } = await import("../../src/core/registration");
const { db } = await import("../../src/db");

const now = new Date();
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

/** The labels of the card's callback buttons — the actions actually offered. */
const actions = (eventId: number, userId: number): string[] => {
  const card = renderEventCard(eventId, userId, "en");
  if (!card) return [];
  const rows = (card.keyboard.toJSON() as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard;
  return rows.flat().filter((button) => button.callback_data !== undefined).map((button) => button.text);
};

const cardText = (eventId: number, userId: number): string => String(renderEventCard(eventId, userId, "en")?.text ?? "");

describe("bot event card", () => {
  beforeEach(() => {
    db.$client.query("DELETE FROM registrations").run();
    db.$client.query("DELETE FROM events").run();
    db.$client.query("DELETE FROM users").run();
    for (let id = 1; id <= 3; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
    db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, created_by) VALUES (1, 'run', 'x', ?, 'park', 1, 'published', 1)")
      .run(unix(new Date(now.getTime() + 86_400_000)));
  });

  test("offers a sign-up button while spots remain", () => {
    expect(actions(1, 2)).toEqual(["✅ Sign up"]);
  });

  test("offers the queue once full, when the queue is on", () => {
    joinEvent(db, 1, 2, now);
    expect(actions(1, 3)).toEqual(["⏳ Join the queue"]);
  });

  test("offers nothing and says so when full with the queue off", () => {
    joinEvent(db, 1, 2, now);
    db.$client.query("UPDATE events SET waitlist_enabled = 0 WHERE id = 1").run();
    expect(actions(1, 3)).toEqual([]);
    expect(cardText(1, 3)).toContain("No spots left");
  });

  test("shows a signed-up user their standing instead of a button", () => {
    joinEvent(db, 1, 2, now);
    expect(actions(1, 2)).toEqual([]);
    expect(cardText(1, 2)).toContain("You are signed up");
  });

  test("shows that a user is queued without exposing their place", () => {
    joinEvent(db, 1, 2, now);
    joinEvent(db, 1, 3, now);
    expect(actions(1, 3)).toEqual([]);
    expect(cardText(1, 3)).toContain("You are in the queue");
    expect(cardText(1, 3)).not.toContain("#1");
  });

  test("hides an event the viewer's groups exclude them from", () => {
    db.$client.query("INSERT INTO event_chats (event_id, chat_id) VALUES (1, -100123)").run();
    expect(renderEventCard(1, 2, "en")).toBeNull();
  });
});
