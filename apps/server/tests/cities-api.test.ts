// Test files share one module registry, so the env must match every other suite that
// boots the API: the auth and bot singletons capture whichever file loads first.
process.env.BOT_TOKEN = "12345:notifications-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001,4004";
process.env.WEBHOOK_SECRET = "notifications-webhook";
process.env.CHECKIN_SECRET = "notifications-checkin";
process.env.DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "test";

import { beforeEach, expect, test } from "bun:test";
import { getBotTokenSecretKey, signInitData } from "@gramio/init-data";

const { db } = await import("../src/db");
const { app } = await import("../src/api");
const { bot } = await import("../src/bot");

// The chat routes refresh a chat's name and health from Telegram before answering.
// Left alone that is a real API call against a fake token, which hangs until the
// socket gives up and takes the test with it.
Object.assign(bot.api, {
  getMe: async () => ({ id: 42, is_bot: true, first_name: "sku", username: "skubot" }),
  getChat: async ({ chat_id }: { chat_id: number }) => ({ id: chat_id, type: "supergroup", title: `chat ${chat_id}` }),
  getChatMember: async () => ({ status: "administrator" }),
});

const secretKey = getBotTokenSecretKey(process.env.BOT_TOKEN);
const initDataFor = (id: number) => signInitData({ user: { id, first_name: `u${id}`, language_code: "ru" } }, secretKey);

const call = async (method: string, path: string, id: number, body?: unknown) => {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { "x-init-data": initDataFor(id), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, json: (await response.json()) as any };
};

const GENERAL = 1001;
const MSK_ADMIN = 2002;
const KZN_ORGANIZER = 3003;
const RUNNER = 5005;

const startsAt = new Date(Date.now() + 86_400_000).toISOString();
const draft = (city: string, title: string) => ({ city, title, description: "d", startsAt, location: "park", capacity: null, status: "published" });

const setCity = (id: number, city: string) => db.$client.query("UPDATE users SET city = ? WHERE id = ?").run(city, id);

beforeEach(async () => {
  db.$client.exec("DELETE FROM waitlist_offers; DELETE FROM registrations; DELETE FROM event_organizers; DELETE FROM user_city_roles; DELETE FROM chats; DELETE FROM events; DELETE FROM users;");
  // Rows are created by the request being served, so one call each is enough.
  for (const id of [GENERAL, MSK_ADMIN, KZN_ORGANIZER, RUNNER]) await call("GET", "/api/me", id);
  db.$client.query("INSERT INTO user_city_roles (city, user_id, role) VALUES ('msk', ?, 'admin')").run(MSK_ADMIN);
  db.$client.query("INSERT INTO user_city_roles (city, user_id, role) VALUES ('kzn', ?, 'organizer')").run(KZN_ORGANIZER);
});

test("a runner browses their own branch, and nothing at all before choosing one", async () => {
  await call("POST", "/api/organizer/events", GENERAL, draft("spb", "Питер"));
  await call("POST", "/api/organizer/events", GENERAL, draft("msk", "Москва"));

  // No branch chosen yet: an empty list, not a merged one.
  expect((await call("GET", "/api/events", RUNNER)).json).toEqual([]);

  setCity(RUNNER, "spb");
  expect((await call("GET", "/api/events", RUNNER)).json.map((e: any) => e.title)).toEqual(["Питер"]);

  setCity(RUNNER, "msk");
  expect((await call("GET", "/api/events", RUNNER)).json.map((e: any) => e.title)).toEqual(["Москва"]);
});

test("a run in another branch stays reachable by link, and stays visible once joined", async () => {
  const moscow = (await call("POST", "/api/organizer/events", GENERAL, draft("msk", "Москва"))).json;
  setCity(RUNNER, "spb");

  // The city filter is for browsing; it never hides an event from its own link.
  expect((await call("GET", `/api/events/${moscow.id}`, RUNNER)).status).toBe(200);
  expect((await call("POST", `/api/events/${moscow.id}/join`, RUNNER)).status).toBe(200);
  expect((await call("GET", "/api/events", RUNNER)).json.map((e: any) => e.title)).toEqual(["Москва"]);
});

test("a branch admin raises and edits events in their branch only", async () => {
  const mine = (await call("POST", "/api/organizer/events", MSK_ADMIN, draft("msk", "Моя"))).json;
  expect(mine.city).toBe("msk");

  expect((await call("POST", "/api/organizer/events", MSK_ADMIN, draft("kzn", "Чужая"))).status).toBe(403);

  const theirs = (await call("POST", "/api/organizer/events", GENERAL, draft("kzn", "Казань"))).json;
  expect((await call("PATCH", `/api/admin/events/${theirs.id}`, MSK_ADMIN, { title: "x" })).status).toBe(403);
  expect((await call("PATCH", `/api/admin/events/${mine.id}`, MSK_ADMIN, { title: "x" })).status).toBe(200);
});

test("an admin permanently deletes a published event in their branch only", async () => {
  const mine = (await call("POST", "/api/organizer/events", MSK_ADMIN, draft("msk", "Моя"))).json;
  const theirs = (await call("POST", "/api/organizer/events", GENERAL, draft("kzn", "Казань"))).json;

  expect((await call("DELETE", `/api/admin/events/${theirs.id}`, MSK_ADMIN)).status).toBe(403);
  expect((await call("DELETE", `/api/admin/events/${mine.id}`, MSK_ADMIN)).status).toBe(200);
  expect((await call("GET", `/api/events/${mine.id}`, MSK_ADMIN)).status).toBe(404);
  expect((await call("GET", `/api/events/${theirs.id}`, GENERAL)).status).toBe(200);
});

test("an organizer may raise a run and then run it, but not the branch's other runs", async () => {
  const mine = (await call("POST", "/api/organizer/events", KZN_ORGANIZER, { ...draft("kzn", "Моя"), status: undefined })).json;
  expect(mine.city).toBe("kzn");
  // Creating it named them on it, so the edit form they just left still opens.
  expect((await call("PATCH", `/api/organizer/events/${mine.id}`, KZN_ORGANIZER, { title: "x" })).status).toBe(200);

  const other = (await call("POST", "/api/organizer/events", GENERAL, draft("kzn", "Чужая"))).json;
  expect((await call("PATCH", `/api/organizer/events/${other.id}`, KZN_ORGANIZER, { title: "x" })).status).toBe(403);
  // And the admin-only fields stay out of reach even on their own event.
  expect((await call("PATCH", `/api/admin/events/${mine.id}`, KZN_ORGANIZER, { status: "published" })).status).toBe(403);
});

test("an organizer cannot smuggle in the admin-only fields at creation", async () => {
  expect((await call("POST", "/api/organizer/events", KZN_ORGANIZER, { ...draft("kzn", "x"), status: "published" })).status).toBe(403);
  expect((await call("POST", "/api/organizer/events", KZN_ORGANIZER, { ...draft("kzn", "x"), status: undefined, homeChatId: -1 })).status).toBe(403);
});

test("moving a run between branches takes authority over both ends", async () => {
  const event = (await call("POST", "/api/organizer/events", MSK_ADMIN, draft("msk", "Моя"))).json;
  expect((await call("PATCH", `/api/admin/events/${event.id}`, MSK_ADMIN, { city: "kzn" })).status).toBe(403);
  expect((await call("PATCH", `/api/admin/events/${event.id}`, GENERAL, { city: "kzn" })).json.city).toBe("kzn");
});

test("a branch admin appoints organizers in their branch, and nothing more", async () => {
  expect((await call("PUT", `/api/admin/users/${RUNNER}/roles`, MSK_ADMIN, { city: "msk", role: "organizer" })).status).toBe(200);
  expect((await call("PUT", `/api/admin/users/${RUNNER}/roles`, MSK_ADMIN, { city: "spb", role: "organizer" })).status).toBe(403);
  expect((await call("PUT", `/api/admin/users/${RUNNER}/roles`, MSK_ADMIN, { city: "msk", role: "admin" })).status).toBe(403);

  // Nor may they unseat a peer their own branch already has.
  db.$client.query("INSERT OR REPLACE INTO user_city_roles (city, user_id, role) VALUES ('msk', ?, 'admin')").run(RUNNER);
  expect((await call("PUT", `/api/admin/users/${RUNNER}/roles`, MSK_ADMIN, { city: "msk", role: null })).status).toBe(403);
  expect((await call("PUT", `/api/admin/users/${RUNNER}/roles`, GENERAL, { city: "msk", role: null })).status).toBe(200);
});

test("banning stays a club-wide act, out of a branch admin's hands", async () => {
  expect((await call("POST", `/api/admin/users/${RUNNER}/ban`, MSK_ADMIN)).status).toBe(403);
  expect((await call("POST", `/api/admin/users/${RUNNER}/promote`, MSK_ADMIN)).status).toBe(403);
  expect((await call("POST", `/api/admin/users/${RUNNER}/ban`, GENERAL)).status).toBe(200);
});

test("an event may only reach chats of its own branch", async () => {
  db.$client.query("INSERT INTO chats (id, city) VALUES (-1, 'msk'), (-2, 'kzn'), (-3, NULL)").run();

  expect((await call("POST", "/api/organizer/events", GENERAL, { ...draft("msk", "x"), groups: [-1] })).status).toBe(200);
  expect((await call("POST", "/api/organizer/events", GENERAL, { ...draft("msk", "x"), groups: [-2] })).json.error).toBe("unknown_group");
  // An unfiled chat belongs to nobody yet, so it is reachable from nowhere.
  expect((await call("POST", "/api/organizer/events", GENERAL, { ...draft("msk", "x"), homeChatId: -3 })).json.error).toBe("unknown_home_chat");
});

test("filing a chat under a branch is the general admin's call alone", async () => {
  db.$client.query("INSERT INTO chats (id, city) VALUES (-1, NULL)").run();
  expect((await call("PUT", "/api/admin/chats/-1", MSK_ADMIN, { city: "msk" })).status).toBe(403);
  expect((await call("PUT", "/api/admin/chats/-1", GENERAL, { city: "msk" })).status).toBe(200);

  // A branch admin sees their own chats but is not shown the ones awaiting a branch.
  db.$client.query("INSERT INTO chats (id, city) VALUES (-9, NULL)").run();
  const seen = (await call("GET", "/api/admin/chats", MSK_ADMIN)).json;
  expect(seen.canAssign).toBe(false);
  expect(seen.chats.map((c: any) => c.id)).toEqual([-1]);
});

test("stats narrow to the branch you run", async () => {
  await call("POST", "/api/organizer/events", GENERAL, draft("spb", "a"));
  await call("POST", "/api/organizer/events", GENERAL, draft("msk", "b"));

  expect((await call("GET", "/api/admin/stats", GENERAL)).json.totalEvents).toBe(2);
  expect((await call("GET", "/api/admin/stats", MSK_ADMIN)).json.totalEvents).toBe(1);
  expect((await call("GET", "/api/admin/stats?city=spb", MSK_ADMIN)).status).toBe(403);
});

test("the organizer list shows a branch admin their whole branch", async () => {
  await call("POST", "/api/organizer/events", GENERAL, draft("msk", "a"));
  await call("POST", "/api/organizer/events", GENERAL, draft("kzn", "b"));

  const titles = (await call("GET", "/api/organizer/events", MSK_ADMIN)).json.map((e: any) => e.title);
  expect(titles).toEqual(["a"]);
  expect((await call("GET", "/api/organizer/events", GENERAL)).json).toHaveLength(2);
});
