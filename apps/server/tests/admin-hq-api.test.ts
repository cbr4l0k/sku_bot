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
const initDataFor = (id: number) => signInitData({ user: { id, first_name: `u${id}`, language_code: "ru" } }, secretKey);

const call = async <T = unknown>(method: string, path: string, id: number, body?: unknown) => {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { "x-init-data": initDataFor(id), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, json: (await response.json()) as T };
};

const GENERAL = 1001;
const SPB_ADMIN = 2002;
const RUNNER = 5005;

beforeEach(async () => {
  db.$client.exec("DELETE FROM waitlist_offers; DELETE FROM registrations; DELETE FROM event_organizers; DELETE FROM user_city_roles; DELETE FROM chats; DELETE FROM ticket_tiers; DELETE FROM events; DELETE FROM users;");
  for (const id of [GENERAL, SPB_ADMIN, RUNNER]) await call("GET", "/api/me", id);
  db.$client.query("INSERT INTO user_city_roles (city, user_id, role) VALUES ('spb', ?, 'admin')").run(SPB_ADMIN);
});

test("needs attention is for whoever runs a branch, and branchless chats only for the club", async () => {
  db.$client.exec("INSERT INTO chats (id, city, title) VALUES (-7, NULL, 'Lost')");
  expect((await call("GET", "/api/admin/attention", RUNNER)).status).toBe(403);
  expect((await call("GET", "/api/admin/attention?city=msk", SPB_ADMIN)).status).toBe(403);
  expect((await call<{ unassignedChats: unknown[] }>("GET", "/api/admin/attention", SPB_ADMIN)).json.unassignedChats).toEqual([]);
  expect((await call<{ unassignedChats: { id: number }[] }>("GET", "/api/admin/attention", GENERAL)).json.unassignedChats)
    .toMatchObject([{ id: -7, title: "Lost" }]);
});

test("stats carry this month's numbers alongside the all-time ones", async () => {
  const stats = await call<{ totalEvents: number; month: { month: string; events: number } }>("GET", "/api/admin/stats", SPB_ADMIN);
  expect(stats.status).toBe(200);
  expect(stats.json).toMatchObject({ totalEvents: 0, month: { events: 0, runners: 0, turnout: null } });
  expect(stats.json.month.month).toMatch(/^\d{4}-\d{2}$/);
});

test("the person card opens for branch admins and saves several branches at once", async () => {
  expect((await call("GET", `/api/admin/users/${RUNNER}`, RUNNER)).status).toBe(403);
  expect((await call("GET", "/api/admin/users/999", SPB_ADMIN)).status).toBe(404);
  const card = await call<{ id: number; canBlock: boolean; roles: { city: string; role: string | null }[] }>("GET", `/api/admin/users/${RUNNER}`, SPB_ADMIN);
  expect(card.json).toMatchObject({ id: RUNNER, canBlock: false, stats: { signUps: 0, turnout: null, led: 0 } });

  const forbidden = await call("PUT", `/api/admin/users/${RUNNER}/city-roles`, SPB_ADMIN, { roles: [{ city: "spb", role: "organizer" }, { city: "msk", role: "organizer" }] });
  expect(forbidden).toEqual({ status: 403, json: { error: "forbidden" } });

  const saved = await call<{ roles: { city: string; role: string | null }[] }>("PUT", `/api/admin/users/${RUNNER}/city-roles`, GENERAL, {
    roles: [{ city: "spb", role: "organizer" }, { city: "msk", role: "admin" }, { city: "kzn", role: null }],
  });
  expect(saved.status).toBe(200);
  expect(saved.json.roles.map((entry) => entry.role)).toEqual(["organizer", "admin", null]);
});

test("a ticketed draft switched back to free is free again", async () => {
  const startsAt = new Date(Date.now() + 86_400_000).toISOString();
  const created = await call<{ id: number; status: string }>("POST", "/api/organizer/events", SPB_ADMIN, {
    city: "spb", title: "Night Run", description: "", startsAt, location: "Palace Square", capacity: null,
  });
  expect(created.json.status).toBe("draft");
  const id = created.json.id;
  await call("PATCH", `/api/organizer/events/${id}`, SPB_ADMIN, { capacity: 200, waitlistEnabled: true });
  const ticketed = await call<{ ticketTiers: { id: number; name: string }[] }>("PUT", `/api/organizer/events/${id}/ticket-tiers`, SPB_ADMIN, {
    tiers: [{ name: "Start", priceMinor: 50000, quota: null }, { name: "Start + pack", priceMinor: 150000, quota: 60 }],
  });
  const start = ticketed.json.ticketTiers.find((tier) => tier.name === "Start");
  // Keeping one tier drops the other outright, since nobody bought it.
  const trimmed = await call<{ ticketTiers: { name: string }[] }>("PUT", `/api/organizer/events/${id}/ticket-tiers`, SPB_ADMIN, {
    tiers: [{ id: start?.id, name: "Start", priceMinor: 50000, quota: null }],
  });
  expect(trimmed.json.ticketTiers.map((tier) => tier.name)).toEqual(["Start"]);
  const free = await call<{ ticketTiers: unknown[] }>("PUT", `/api/organizer/events/${id}/ticket-tiers`, SPB_ADMIN, { tiers: [] });
  expect(free.json.ticketTiers).toEqual([]);

  expect((await call("PATCH", `/api/admin/events/${id}`, SPB_ADMIN, { status: "published" })).status).toBe(200);
  expect((await call("POST", `/api/events/${id}/join`, RUNNER)).status).toBe(200);
});
