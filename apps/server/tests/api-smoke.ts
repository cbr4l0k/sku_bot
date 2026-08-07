process.env.BOT_TOKEN = "12345:smoke-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001,4004";
process.env.WEBHOOK_SECRET = "smoke-webhook";
process.env.CHECKIN_SECRET = "smoke-checkin";
process.env.DATABASE_PATH = ":memory:";
process.env.NODE_ENV = "development";

import { getBotTokenSecretKey, signInitData } from "@gramio/init-data";

const { app } = await import("../src/api");

const secretKey = getBotTokenSecretKey(process.env.BOT_TOKEN);
const initDataFor = (id: number, firstName: string) =>
  signInitData({ user: { id, first_name: firstName, username: `u${id}`, language_code: "ru" } }, secretKey);

const admin = initDataFor(1001, "Admin");
const runner = initDataFor(2002, "Runner");
const runnerB = initDataFor(3003, "RunnerB");

const call = async (method: string, path: string, initData: string, body?: unknown) => {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "x-init-data": initData, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
};

const results: Array<[string, boolean, unknown]> = [];
const check = (name: string, ok: boolean, detail?: unknown) => results.push([name, ok, detail]);

const health = await app.handle(new Request("http://localhost/api/health"));
check("health 200", health.status === 200);

const noAuth = await app.handle(new Request("http://localhost/api/me"));
check("unauthed /me rejected", noAuth.status === 401 || noAuth.status === 422);

const me = await call("GET", "/api/me", admin);
check("admin /me isAdmin", me.status === 200 && (me.json as { isAdmin: boolean }).isAdmin === true);

const created = await call("POST", "/api/admin/events", admin, {
  title: "Смоук-забег", description: "тест", startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  location: "Парк", capacity: 1, status: "published",
});
const eventId = (created.json as { id: number }).id;
check("admin creates event", created.status === 200 && typeof eventId === "number", created.json);

const runnerForbidden = await call("POST", "/api/admin/events", runner, {
  title: "x", description: "x", startsAt: new Date(Date.now() + 86_400_000).toISOString(), location: "x", capacity: null,
});
check("non-admin create forbidden", runnerForbidden.status === 403);

const join1 = await call("POST", `/api/events/${eventId}/join`, runner);
check("runner joins → registered", join1.status === 200 && (join1.json as { status: string }).status === "registered", join1.json);

const join2 = await call("POST", `/api/events/${eventId}/join`, runnerB);
check("runnerB → waitlisted #1", join2.status === 200 && (join2.json as { position: number }).position === 1, join2.json);

const cancel = await call("POST", `/api/events/${eventId}/cancel`, runner);
check("runner cancels", cancel.status === 200);

const events = await call("GET", "/api/events", runnerB);
const evt = (events.json as Array<{ id: number; myPendingOffer: { id: number } | null }>).find((entry) => entry.id === eventId);
check("runnerB has pending offer", Boolean(evt?.myPendingOffer), evt);

if (evt?.myPendingOffer) {
  const accept = await call("POST", `/api/offers/${evt.myPendingOffer.id}/accept`, runnerB);
  check("runnerB accepts offer", accept.status === 200, accept.json);
}

const { mintCheckinToken } = await import("../src/core/checkin");
const token = mintCheckinToken(process.env.CHECKIN_SECRET, eventId, new Date());
const checkin = await call("POST", "/api/checkin", runnerB, { code: token });
check("runnerB checks in via QR token", checkin.status === 200, checkin.json);

const stats = await call("GET", `/api/admin/events/${eventId}/stats`, admin);
check("event stats", stats.status === 200 && (stats.json as { checkedIn: number }).checkedIn === 1, stats.json);

const ban = await call("POST", "/api/admin/users/2002/ban", admin);
const joinBanned = await call("POST", `/api/events/${eventId}/join`, runner);
check("banned user cannot join", ban.status === 200 && joinBanned.status === 403, joinBanned.json);

const traversal = await app.handle(new Request("http://localhost/%2e%2e/%2e%2e/etc/passwd"));
const traversalBody = await traversal.text();
check("path traversal blocked", !traversalBody.includes("root:"), traversal.status);

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}
if (failed) { console.error(`${failed} smoke checks failed`); process.exit(1); }
console.log("API smoke: all passed");
process.exit(0);
