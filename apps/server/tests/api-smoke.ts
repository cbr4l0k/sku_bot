process.env.BOT_TOKEN = "12345:smoke-test-token";
process.env.DOMAIN = "club.example.com";
process.env.ADMIN_IDS = "1001,4004";
process.env.EVENT_GROUPS = "-1001234567890,-1009876543210";
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

/* --------------------------------------------------------------- queue switch */

const noQueue = await call("POST", "/api/admin/events", admin, {
  title: "Без очереди", description: "тест", startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  location: "Парк", capacity: 1, status: "published", waitlistEnabled: false,
});
const noQueueId = (noQueue.json as { id: number }).id;
check("admin creates an event with the queue off", noQueue.status === 200 && (noQueue.json as { waitlistEnabled: boolean }).waitlistEnabled === false, noQueue.json);

const tookLastSpot = await call("POST", `/api/events/${noQueueId}/join`, runnerB);
check("first signup takes the last spot", tookLastSpot.status === 200 && (tookLastSpot.json as { status: string }).status === "registered", tookLastSpot.json);

const turnedAway = await call("POST", `/api/events/${noQueueId}/join`, admin);
check("a full event with no queue turns the next person away", turnedAway.status === 409 && (turnedAway.json as { error: string }).error === "event_full", turnedAway.json);

const queueBackOn = await call("PATCH", `/api/admin/events/${noQueueId}`, admin, { waitlistEnabled: true });
const queued = await call("POST", `/api/events/${noQueueId}/join`, admin);
check("turning the queue on lets the next person queue", queueBackOn.status === 200 && queued.status === 200 && (queued.json as { position: number }).position === 1, queued.json);

/* ------------------------------------------------------------ group restrictions */

// Membership answers come from Telegram; seed the cache so the smoke run needs no network.
const { db } = await import("../src/db");
const groupChat = -1001234567890;
const setMembership = (userId: number, isMember: boolean, ageMs = 0) =>
  db.$client.query("INSERT INTO chat_members (chat_id, user_id, is_member, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET is_member = excluded.is_member, checked_at = excluded.checked_at")
    .run(groupChat, userId, isMember ? 1 : 0, Math.floor((Date.now() - ageMs) / 1000));

// A user untouched by the earlier checks, so "banned" cannot mask "not_eligible".
const outsider = initDataFor(5005, "Outsider");
await call("GET", "/api/me", outsider);
setMembership(5005, false);
setMembership(3003, true);

const restricted = await call("POST", "/api/admin/events", admin, {
  title: "Только свои", description: "тест", startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  location: "Парк", capacity: null, status: "published", groups: [groupChat],
});
const restrictedId = (restricted.json as { id: number }).id;
check("admin restricts an event to a chat", restricted.status === 200 && (restricted.json as { groups: Array<{ id: number }> }).groups[0]?.id === groupChat, restricted.json);

const badGroup = await call("POST", "/api/admin/events", admin, {
  title: "x", description: "x", startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  location: "x", capacity: null, groups: [-1000000000001],
});
check("chat outside EVENT_GROUPS rejected", badGroup.status === 400, badGroup.json);

const hiddenList = await call("GET", "/api/events", outsider);
check("non-member does not see restricted event", !(hiddenList.json as Array<{ id: number }>).some((entry) => entry.id === restrictedId));

const hiddenDetail = await call("GET", `/api/events/${restrictedId}`, outsider);
check("non-member gets 404 on restricted event", hiddenDetail.status === 404, hiddenDetail.json);

const blockedJoin = await call("POST", `/api/events/${restrictedId}/join`, outsider);
check("non-member cannot join restricted event", blockedJoin.status === 403 && (blockedJoin.json as { error: string }).error === "not_eligible", blockedJoin.json);

const memberList = await call("GET", "/api/events", runnerB);
check("chat member sees restricted event", (memberList.json as Array<{ id: number }>).some((entry) => entry.id === restrictedId));

const memberJoin = await call("POST", `/api/events/${restrictedId}/join`, runnerB);
check("chat member joins restricted event", memberJoin.status === 200, memberJoin.json);

setMembership(3003, false);
const stillVisible = await call("GET", `/api/events/${restrictedId}`, runnerB);
check("registered member keeps access after leaving the chat", stillVisible.status === 200, stillVisible.json);

const opened = await call("PATCH", `/api/admin/events/${restrictedId}`, admin, { groups: [] });
const openList = await call("GET", "/api/events", outsider);
check("clearing chats reopens the event", opened.status === 200 && (opened.json as { groups: unknown[] }).groups.length === 0 && (openList.json as Array<{ id: number }>).some((entry) => entry.id === restrictedId), opened.json);

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
