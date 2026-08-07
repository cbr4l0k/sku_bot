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

const secretKey = getBotTokenSecretKey(process.env.BOT_TOKEN);
const initDataFor = (id: number, firstName: string) => signInitData({ user: { id, first_name: firstName, language_code: "ru" } }, secretKey);
const call = async (method: string, path: string, initData: string) => {
  const response = await app.handle(new Request(`http://localhost${path}`, { method, headers: { "x-init-data": initData } }));
  return { status: response.status, json: (await response.json()) as unknown };
};

type Person = { id: number; isAdmin: boolean; isConfiguredAdmin: boolean };
const personIn = (json: unknown, id: number) => (json as Person[]).find((person) => person.id === id);

beforeEach(() => {
  db.$client.exec("DELETE FROM waitlist_offers; DELETE FROM registrations; DELETE FROM event_organizers; DELETE FROM events; DELETE FROM users;");
});

test("every configured admin is an admin, on their very first request", async () => {
  // 1001 already has a row; 4004's row is created by the very request being served.
  db.$client.query("INSERT INTO users (id, first_name) VALUES (1001, 'One')").run();
  expect(await call("GET", "/api/me", initDataFor(1001, "One"))).toMatchObject({ status: 200, json: { isAdmin: true } });
  expect(await call("GET", "/api/me", initDataFor(4004, "Four"))).toMatchObject({ status: 200, json: { isAdmin: true } });
  expect(await call("GET", "/api/me", initDataFor(3003, "Three"))).toMatchObject({ status: 200, json: { isAdmin: false } });
});

test("the people list marks configured admins, and they cannot be demoted", async () => {
  for (const [id, name] of [[1001, "One"], [4004, "Four"], [3003, "Three"]] as const) await call("GET", "/api/me", initDataFor(id, name));

  // Listed by the *second* configured admin — the case the user reported as not working.
  const list = await call("GET", "/api/admin/users", initDataFor(4004, "Four"));
  expect(list.status).toBe(200);
  expect(personIn(list.json, 1001)).toMatchObject({ isAdmin: true, isConfiguredAdmin: true });
  expect(personIn(list.json, 4004)).toMatchObject({ isAdmin: true, isConfiguredAdmin: true });
  expect(personIn(list.json, 3003)).toMatchObject({ isAdmin: false, isConfiguredAdmin: false });

  expect(await call("POST", "/api/admin/users/4004/demote", initDataFor(1001, "One"))).toEqual({ status: 409, json: { error: "configured_admin_cannot_be_demoted" } });
});

test("db-promoted admins stay promotable and demotable", async () => {
  for (const [id, name] of [[1001, "One"], [3003, "Three"]] as const) await call("GET", "/api/me", initDataFor(id, name));
  const admin = initDataFor(1001, "One");

  expect((await call("POST", "/api/admin/users/3003/promote", admin)).status).toBe(200);
  expect(personIn((await call("GET", "/api/admin/users", admin)).json, 3003)).toMatchObject({ isAdmin: true, isConfiguredAdmin: false });
  expect((await call("POST", "/api/admin/users/3003/demote", admin)).status).toBe(200);
  expect(personIn((await call("GET", "/api/admin/users", admin)).json, 3003)).toMatchObject({ isAdmin: false });
});
