process.env.BOT_TOKEN = "12345:notifications-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001";
process.env.WEBHOOK_SECRET = "notifications-webhook";
process.env.CHECKIN_SECRET = "notifications-checkin";
process.env.DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "test";

import { beforeEach, expect, spyOn, test } from "bun:test";
import { getBotTokenSecretKey, signInitData } from "@gramio/init-data";

const { db } = await import("../src/db");
const { dispatchEffects } = await import("../src/notify");
const { app } = await import("../src/api");

const startsAt = new Date("2030-08-05T16:30:00Z");
const initData = signInitData({ user: { id: 1001, first_name: "Admin", language_code: "ru" } }, getBotTokenSecretKey(process.env.BOT_TOKEN));

beforeEach(() => {
  db.$client.exec("DELETE FROM waitlist_offers; DELETE FROM registrations; DELETE FROM event_organizers; DELETE FROM events; DELETE FROM users;");
  db.$client.query("INSERT INTO users (id, first_name, locale) VALUES (1001, 'Admin', 'ru'), (2002, 'Runner', 'ru')").run();
  db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, created_by) VALUES (1, 'Вечерний забег', 'Лёгкий темп', ?, 'Таврический сад', 10, 'published', 1001)").run(Math.floor(startsAt.getTime() / 1000));
});

test("a failed offer delivery does not block later effects", async () => {
  db.$client.query("INSERT INTO waitlist_offers (id, event_id, user_id, offered_at, expires_at) VALUES (1, 1, 1001, 1, 2), (2, 1, 2002, 1, 2)").run();
  let calls = 0;
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls++;
    if (calls === 1) throw new Error("network unavailable");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { headers: { "content-type": "application/json" } });
  });

  await dispatchEffects([
    { kind: "offer_created", offerId: 1, userId: 1001, eventId: 1, expiresAt: startsAt },
    { kind: "offer_created", offerId: 2, userId: 2002, eventId: 1, expiresAt: startsAt },
  ]);

  expect(calls).toBe(2);
  expect(db.$client.query<{ message_id: number | null }, [number]>("SELECT message_id FROM waitlist_offers WHERE id = ?").get(2)?.message_id).toBe(42);
  fetchSpy.mockRestore();
  warnSpy.mockRestore();
});

test("event updates notify only real changes with participant-facing copy", async () => {
  db.$client.query("INSERT INTO registrations (event_id, user_id, status) VALUES (1, 2002, 'registered')").run();
  const messages: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    messages.push(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { headers: { "content-type": "application/json" } });
  });
  const call = (body: object) => app.handle(new Request("http://localhost/api/organizer/events/1", {
    method: "PATCH",
    headers: { "x-init-data": initData, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  await call({ title: "Вечерний забег", description: "Лёгкий темп", startsAt: startsAt.toISOString(), location: "Таврический сад", capacity: 10 });
  await Bun.sleep(0);
  expect(messages).toHaveLength(0);

  await call({ location: "Новая набережная" });
  await Bun.sleep(0);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("Новое место: Новая набережная");
  expect(messages[0]).not.toContain("• location");
  fetchSpy.mockRestore();
});

test("HTTPS map links round-trip, empty links clear, and unsafe links are rejected", async () => {
  const request = (method: string, path: string, body: object) => app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { "x-init-data": initData, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const startsAt = new Date("2030-08-06T16:30:00Z").toISOString();
  const created = await request("POST", "/api/admin/events", {
    title: "Утренний забег", description: "Лёгкий темп", startsAt, location: "Парк", locationUrl: "https://maps.example.com/park", capacity: null,
  });
  const event = await created.json() as { id: number; locationUrl: string | null };
  expect(created.status).toBe(200);
  expect(event.locationUrl).toBe("https://maps.example.com/park");

  const patched = await request("PATCH", `/api/admin/events/${event.id}`, { locationUrl: "https://maps.example.com/new-park" });
  expect(patched.status).toBe(200);
  expect((await patched.json() as { locationUrl: string | null }).locationUrl).toBe("https://maps.example.com/new-park");

  const listed = await app.handle(new Request("http://localhost/api/organizer/events", { headers: { "x-init-data": initData } }));
  expect((await listed.json() as Array<{ id: number; locationUrl: string | null }>).find((item) => item.id === event.id)?.locationUrl).toBe("https://maps.example.com/new-park");

  const cleared = await request("PATCH", `/api/organizer/events/${event.id}`, { locationUrl: "" });
  expect(cleared.status).toBe(200);
  expect((await cleared.json() as { locationUrl: string | null }).locationUrl).toBeNull();

  const unsafe = await request("PATCH", `/api/admin/events/${event.id}`, { locationUrl: "javascript:alert(1)" });
  expect(unsafe.status).toBe(400);
  expect(await unsafe.json()).toEqual({ error: "invalid_location_url" });
});
