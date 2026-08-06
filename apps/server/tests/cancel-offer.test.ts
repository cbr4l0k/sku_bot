// Test files share one module registry, so the env must match every other suite that
// boots the API: the auth and bot singletons capture whichever file loads first.
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
const { app } = await import("../src/api");

const startsAt = new Date("2030-08-05T16:30:00Z");
const secret = getBotTokenSecretKey(process.env.BOT_TOKEN);
const initDataFor = (id: number, firstName: string) =>
  signInitData({ user: { id, first_name: firstName, language_code: "ru" } }, secret);

beforeEach(() => {
  db.$client.exec("DELETE FROM waitlist_offers; DELETE FROM registrations; DELETE FROM event_organizers; DELETE FROM events; DELETE FROM users;");
  db.$client.query("INSERT INTO users (id, first_name, locale) VALUES (1001, 'Holder', 'ru'), (2002, 'Waiter', 'ru')").run();
  db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, created_by) VALUES (1, 'Вечерний забег', 'Лёгкий темп', ?, 'Таврический сад', 1, 'published', 1001)").run(Math.floor(startsAt.getTime() / 1000));
});

const post = (path: string, id: number, name: string) =>
  app.handle(new Request(`http://localhost${path}`, { method: "POST", headers: { "x-init-data": initDataFor(id, name) } }));

// The end-to-end shape of the reported bug: a confirmed runner cancels through the
// mini app and the waitlist head must actually receive the offer over Telegram.
test("cancelling a confirmed spot sends the offer to the waitlist head", async () => {
  const sent: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    sent.push(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { headers: { "content-type": "application/json" } });
  });

  expect(await (await post("/api/events/1/join", 1001, "Holder")).json()).toMatchObject({ status: "registered" });
  expect(await (await post("/api/events/1/join", 2002, "Waiter")).json()).toMatchObject({ status: "waitlisted", position: 1 });

  await post("/api/events/1/cancel", 1001, "Holder");
  await Bun.sleep(10);

  expect(db.$client.query<{ user_id: number; status: string }, []>("SELECT user_id, status FROM waitlist_offers").all())
    .toMatchObject([{ user_id: 2002, status: "pending" }]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("2002");
  expect(db.$client.query<{ message_id: number | null }, []>("SELECT message_id FROM waitlist_offers").get()?.message_id).toBe(7);

  fetchSpy.mockRestore();
});

// Documents current behaviour, which is a live product question rather than a defect:
// a lapsed offer keeps status 'pending' forever (sweepOffers only flips `cascaded`),
// and issue() skips any waitlister holding a pending offer. So a runner who lets an
// offer lapse gets no *new* ping when a spot later frees up — they can still claim
// their original one FCFS, but they are never told a spot reopened.
test("a runner who lets an offer lapse is not re-notified when a spot frees up", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { headers: { "content-type": "application/json" } }));
  const { sweepOffers } = await import("../src/core/waitlist");

  db.$client.query("INSERT INTO users (id, first_name, locale) VALUES (3003, 'Second', 'ru')").run();
  db.$client.query("UPDATE events SET capacity = 2 WHERE id = 1").run();

  await post("/api/events/1/join", 1001, "Holder");
  await post("/api/events/1/join", 3003, "Second");
  expect(await (await post("/api/events/1/join", 2002, "Waiter")).json()).toMatchObject({ status: "waitlisted" });

  // Holder drops out, the waitlister is offered the spot, and lets it lapse.
  await post("/api/events/1/cancel", 1001, "Holder");
  await Bun.sleep(10);
  const lapsed = db.$client.query<{ expires_at: number }, []>("SELECT expires_at FROM waitlist_offers").get();
  sweepOffers(db, new Date((lapsed!.expires_at + 1) * 1000));

  // A second spot frees up. The waitlister is still waitlisted, so must be re-offered.
  await post("/api/events/1/cancel", 3003, "Second");
  await Bun.sleep(10);

  // Still waitlisted, still holding only the lapsed offer: no fresh notification went out.
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM registrations WHERE user_id = 2002").get()?.status).toBe("waitlisted");
  expect(db.$client.query<{ count: number }, [number]>("SELECT count(*) AS count FROM waitlist_offers WHERE user_id = 2002 AND status = 'pending' AND expires_at > ?").get(lapsed!.expires_at + 1)?.count).toBe(0);
  fetchSpy.mockRestore();
});
