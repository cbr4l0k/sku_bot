import { Effect } from "effect";
import { Elysia, t } from "elysia";

import { cities, cityRoles, type CitySlug } from "@sku/cities";
import {
  and,
  asc,
  chats,
  desc,
  eq,
  eventProductVariants,
  eventProducts,
  eventOrganizers,
  eventSeries,
  events,
  inArray,
  isNull,
  ne,
  or,
  registrations,
  seriesChats,
  seriesOrganizers,
  seriesProductVariants,
  seriesProducts,
  seriesTicketTiers,
  sql,
  ticketOrders,
  ticketTiers,
  userCityRoles,
  users,
  waitlistOffers,
} from "@sku/db";
import { bot } from "../bot";
import type { EventChange } from "../bot/event-card";
import {
  checkIn,
  isEventOver,
  manualToggleCheckin,
  mintCheckinToken,
  mintTicketToken,
  scanTicket,
  toggleHandover,
  turnIn,
  verifyCheckinToken,
  verifyTicketToken,
} from "../core/checkin";
import { chatState, chatTitle, refreshChatStates, telegramMembership } from "../bot/membership";
import {
  canSeeEvent,
  chatsGatingLiveEvents,
  chatsOfEvent,
  refreshMemberships,
  setEventChats,
  visibleToUser,
} from "../core/membership";
import {
  adminCities,
  canAdminCity,
  canCreateEventIn,
  canGrantRole,
  canManageEvent,
  inCityForUser,
  organizerCities,
  type Actor,
} from "../core/cities";
import { assignableChats, chatById, chatCatalog, setChatCity } from "../core/chats";
import { botEventLink, miniAppEventLink } from "../core/links";
import { cancelRegistration, joinEvent } from "../core/registration";
import {
  cancelPendingOrder,
  createCheckout,
  orderForUser,
  ordersForEvent,
  ordersForUser,
  reconcilePayment,
  reconcileRefund,
  refundCanceledEvent,
  requestAdminRefund,
  requestUserRefund,
} from "../core/tickets";
import { syncAllStaff, syncEventStaff } from "../core/staff";
import { eventStats, globalStats, monthStats } from "../core/stats";
import { needsAttention } from "../core/attention";
import { personCard, setCityRoles } from "../core/people";
import { attachEvent, detachEvent, seriesStats, setSeriesLeads, setSeriesReminders, setSeriesWaitlist, skipNext, spawnOccurrence, unknownUserIds } from "../core/series";
import { checkinMethodOf, eventPhase, eventSummary, hqOverview, rosterFlags, seriesSummary } from "../core/hq";
import { acceptOffer, cancelEvent, endEvent, issueOffers, reopenEvent, setCapacity } from "../core/waitlist";
import { loadEnv } from "../env";
import { paymentProvider, paymentsConfigured } from "../payments";
import { dispatchEffects, notifyEventCanceled, notifyEventUpdated } from "../notify";
import type { NotificationEffect } from "../core/types";
import { runtime } from "../runtime";
import { Database, Payments } from "../services";
import { auth } from "./auth";

const env = loadEnv();
const adminIds = new Set(env.ADMIN_IDS);
const miniappDist = new URL("../../../miniapp/dist/", import.meta.url);
const now = () => new Date();
const iso = (value: Date | null) => value?.toISOString() ?? null;
/**
 * Routes hand their actions to the server runtime with every rejection already
 * answered, so an unhandled one cannot leak out as a 500. Synchronous actions keep
 * their route synchronous.
 */
const run = <A>(action: Effect.Effect<A, never, Database>) => runtime.runSync(action);
const runAsync = <A>(action: Effect.Effect<A, never, Database>) => runtime.runPromise(action);
/** Detached from the request: a slow or failing Telegram never holds up — or fails — the response. */
const background = (action: Effect.Effect<void, never, Database>) => {
  void runtime.runPromise(action).catch(console.error);
};
const fireEffects = (effects: NotificationEffect[]) => background(dispatchEffects(effects));
type ErrorStatus = (code: 400 | 403 | 404 | 409 | 503, response: { error: string }) => { error: string };
const error = (status: unknown, code: 400 | 403 | 404 | 409 | 503, message: string) => (status as ErrorStatus)(code, { error: message });

const staticFile = async (pathname: string) => {
  const fallback = Bun.file(new URL("index.html", miniappDist));
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return fallback;
  }
  // Reject anything that could escape the dist directory once URL-decoded.
  if (decoded.includes("..") || decoded.includes("\0")) return fallback;
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const asset = Bun.file(new URL(relativePath, miniappDist));
  if (await asset.exists()) return asset;
  return fallback;
};

const userView = (user: typeof users.$inferSelect) => ({
  id: user.id,
  firstName: user.firstName,
  lastName: user.lastName,
  username: user.username,
  phone: user.phone,
  locale: user.locale,
  city: user.city,
  // Env-configured admins are admins even if their row predates the boot-time sync.
  isAdmin: user.isAdmin || adminIds.has(user.id),
  isBanned: user.isBanned,
  createdAt: iso(user.createdAt),
});

const ticketTierView = Effect.fnUntraced(function* (tier: typeof ticketTiers.$inferSelect) {
  const db = yield* Database;
  return {
    ...tier,
    salesStartAt: iso(tier.salesStartAt),
    salesEndAt: iso(tier.salesEndAt),
    createdAt: tier.createdAt.toISOString(),
    updatedAt: tier.updatedAt.toISOString(),
    claimed: db.select({ value: sql<number>`count(*)` }).from(ticketOrders)
      .where(and(eq(ticketOrders.ticketTierId, tier.id), inArray(ticketOrders.status, ["awaiting_payment", "payment_succeeded", "fulfilled", "refund_pending", "refund_failed"]))).get()?.value ?? 0,
  };
});

const eventProductView = Effect.fnUntraced(function* (product: typeof eventProducts.$inferSelect) {
  const db = yield* Database;
  return {
    ...product,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    claimed: db.$client.query<{ value: number | null }, [number]>(`
      SELECT sum(i.quantity) AS value FROM order_items i
      JOIN ticket_orders o ON o.id = i.order_id
      WHERE i.event_product_id = ?
        AND o.status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
    `).get(product.id)?.value ?? 0,
    variants: db.select().from(eventProductVariants).where(eq(eventProductVariants.productId, product.id))
      .orderBy(asc(eventProductVariants.sortOrder), asc(eventProductVariants.id)).all().map((variant) => ({
        ...variant,
        createdAt: variant.createdAt.toISOString(),
        updatedAt: variant.updatedAt.toISOString(),
        claimed: db.$client.query<{ value: number | null }, [number]>(`
          SELECT sum(i.quantity) AS value FROM order_items i
          JOIN ticket_orders o ON o.id = i.order_id
          WHERE i.event_product_variant_id = ?
            AND o.status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
        `).get(variant.id)?.value ?? 0,
      })),
  };
});

/** A chat as the admin screens name it: by its last known title, or its id while none is known. */
const namedChat = Effect.fnUntraced(function* (id: number) {
  return { id, title: (yield* chatTitle(id)) ?? String(id) };
});

const eventView = Effect.fnUntraced(function* (event: typeof events.$inferSelect) {
  const db = yield* Database;
  return {
    ...event,
    groups: yield* Effect.forEach(yield* chatsOfEvent(event.id), namedChat),
    homeChat: event.homeChatId === null ? null : yield* namedChat(event.homeChatId),
    startsAt: event.startsAt.toISOString(),
    endedAt: iso(event.endedAt),
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    ticketTiers: yield* Effect.forEach(db.select().from(ticketTiers).where(eq(ticketTiers.eventId, event.id))
      .orderBy(asc(ticketTiers.sortOrder), asc(ticketTiers.id)).all(), ticketTierView),
    products: yield* Effect.forEach(db.select().from(eventProducts).where(eq(eventProducts.eventId, event.id))
      .orderBy(asc(eventProducts.sortOrder), asc(eventProducts.id)).all(), eventProductView),
    paymentsConfigured,
    pendingTicketCount: db.select({ value: sql<number>`count(*)` }).from(ticketOrders)
      .where(and(
        eq(ticketOrders.eventId, event.id),
        sql`${ticketOrders.ticketTierId} IS NOT NULL`,
        inArray(ticketOrders.status, ["awaiting_payment", "payment_succeeded"]),
      )).get()?.value ?? 0,
  };
});

const seriesTierView = (tier: typeof seriesTicketTiers.$inferSelect) => ({
  ...tier,
  createdAt: tier.createdAt.toISOString(),
  updatedAt: tier.updatedAt.toISOString(),
});

const seriesProductView = Effect.fnUntraced(function* (product: typeof seriesProducts.$inferSelect) {
  const db = yield* Database;
  return {
    ...product,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    variants: db.select().from(seriesProductVariants).where(eq(seriesProductVariants.productId, product.id))
      .orderBy(asc(seriesProductVariants.sortOrder), asc(seriesProductVariants.id)).all().map((variant) => ({
        ...variant,
        createdAt: variant.createdAt.toISOString(),
        updatedAt: variant.updatedAt.toISOString(),
      })),
  };
});

const seriesView = (series: typeof eventSeries.$inferSelect) => ({
  ...series,
  nextStartsAt: iso(series.nextStartsAt),
  createdAt: series.createdAt.toISOString(),
  updatedAt: series.updatedAt.toISOString(),
});

/**
 * A chat belongs to exactly one branch, so an event may only reach chats of its
 * own. This is what keeps a Kazan admin out of Moscow's groups. Stored rows
 * outlive the catalog, so an event keeps whatever it was given before a chat moved.
 */
const unknownGroup = Effect.fnUntraced(function* (city: CitySlug, groups: readonly number[]) {
  const allowed = new Set(yield* assignableChats(city));
  return groups.some((id) => !allowed.has(id));
});
/** Guests can only be funnelled into a chat of the event's own branch. */
const unknownHomeChat = Effect.fnUntraced(function* (city: CitySlug, chatId: number | null | undefined) {
  return chatId !== null && chatId !== undefined && !(yield* assignableChats(city)).includes(chatId);
});

/** Telegram owns membership, so refresh what the caller is about to be filtered against. */
const syncMemberships = (userId: number, chatIds: readonly number[]) =>
  refreshMemberships(telegramMembership, userId, chatIds, now());

const parseDate = (value: string): Date | undefined => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const parseLocationUrl = (value: string | null): string | null | undefined => {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    return new URL(normalized).protocol === "https:" ? normalized : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Load an event and settle whether the caller may run it, in one step — every
 * organizer route needs both and each used to spell the pair out itself.
 */
const manageable = Effect.fnUntraced(function* (actor: Actor, eventId: number) {
  const event = (yield* Database).select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return { denied: "event_not_found" as const, code: 404 as const };
  if (!(yield* canManageEvent(actor, event))) return { denied: "forbidden" as const, code: 403 as const };
  return { event };
});

/** Runs at least one branch, and so has someone to appoint and something to count. */
const runsAnyBranch = (actor: Actor) => actor.isGlobalAdmin || adminCities(actor).length > 0;

/** The same, for the powers reserved to whoever runs the branch. */
const administrable = Effect.fnUntraced(function* (actor: Actor, eventId: number) {
  const event = (yield* Database).select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return { denied: "event_not_found" as const, code: 404 as const };
  if (!canAdminCity(actor, event.city)) return { denied: "forbidden" as const, code: 403 as const };
  return { event };
});

/**
 * Editing a template changes every future draft and therefore belongs to branch
 * admins. Spawning is narrower: a named organizer may press the button because
 * the copied organizer row guarantees they can manage the event it creates.
 */
const manageableSeries = Effect.fnUntraced(function* (actor: Actor, seriesId: number, namedOrganizer = false) {
  const db = yield* Database;
  const series = db.select().from(eventSeries).where(eq(eventSeries.id, seriesId)).get();
  if (!series) return { denied: "series_not_found" as const, code: 404 as const };
  const named = namedOrganizer && Boolean(db.select({ seriesId: seriesOrganizers.seriesId }).from(seriesOrganizers)
    .where(and(eq(seriesOrganizers.seriesId, seriesId), eq(seriesOrganizers.userId, actor.userId))).get());
  if (!canAdminCity(actor, series.city) && !named) return { denied: "forbidden" as const, code: 403 as const };
  return { series };
});

/** 1-based place in the queue, or null when they are not queueing. */
const waitlistPositionOf = Effect.fnUntraced(function* (eventId: number, userId: number) {
  const index = (yield* Database).select({ userId: registrations.userId }).from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "waitlisted")))
    .orderBy(asc(registrations.createdAt), asc(registrations.id)).all()
    .findIndex((row) => row.userId === userId);
  return index === -1 ? null : index + 1;
});

/** Who runs it, for the "led by" line runners see. */
const organizersOf = (eventId: number) => Database.useSync((db) => db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
  .from(eventOrganizers).innerJoin(users, eq(eventOrganizers.userId, users.id))
  .where(eq(eventOrganizers.eventId, eventId)).orderBy(asc(users.firstName)).all());

/**
 * A runner's record: "runs" are check-ins, and turnout is check-ins over every
 * finished event they held a spot on. Staff rows are the job, not a run.
 */
const runnerStats = Effect.fnUntraced(function* (userId: number) {
  const row = (yield* Database).$client.query<{ runs: number | null; held: number | null }, [number]>(`
    SELECT sum(r.status = 'checked_in') AS runs, count(*) AS held
    FROM registrations r JOIN events e ON e.id = r.event_id
    WHERE r.user_id = ? AND r.is_staff = 0 AND e.ended_at IS NOT NULL
      AND r.status IN ('registered', 'checked_in')
  `).get(userId);
  const runs = row?.runs ?? 0;
  const held = row?.held ?? 0;
  return { runs, turnout: held > 0 ? runs / held : null };
});

const participantEvent = (eventId: number) => Database.useSync((db) => db.select().from(events)
  .where(and(eq(events.id, eventId), eq(events.status, "published"))).get());

/**
 * An event where something was for sale — a tier, or merch on an otherwise free
 * run. These are the events that switch to runner-held tickets: the organizer's
 * projected code is still the fastest way through a free door, but the moment
 * money is involved the club needs to know *who* came through and what they are
 * owed, and only a scan of the runner's own ticket answers that.
 */
const isPaidEvent = (eventId: number) => Database.useSync((db) =>
  db.select({ id: ticketTiers.id }).from(ticketTiers).where(eq(ticketTiers.eventId, eventId)).get() !== undefined
  || db.select({ id: eventProducts.id }).from(eventProducts).where(eq(eventProducts.eventId, eventId)).get() !== undefined);

/** The tier they bought, by the name it carried at the time of sale. */
const ticketNameFor = (eventId: number, userId: number) => Database.useSync((db) => db.select({ ticketName: ticketOrders.ticketName })
  .from(ticketOrders)
  .where(and(eq(ticketOrders.eventId, eventId), eq(ticketOrders.userId, userId), sql`${ticketOrders.ticketTierId} IS NOT NULL`))
  .orderBy(desc(ticketOrders.createdAt)).get()?.ticketName ?? null);

/**
 * What someone bought besides the seat, per line, with whether it has changed
 * hands. Refund-pending lines stay on the list: the money is still moving, and
 * the club would rather see the row and decide than have it vanish at the door.
 */
const purchaseLines = (eventId: number, userId: number) => Database.useSync((db) => db.$client
  .query<{ id: number; name: string; quantity: number; kind: "merchandise" | "addon"; handed_over_at: number | null }, [number, number]>(`
    SELECT i.id, i.name || CASE WHEN i.variant_name IS NULL THEN '' ELSE ' · ' || i.variant_name END AS name,
      i.quantity, i.kind, i.handed_over_at FROM order_items i
    JOIN ticket_orders o ON o.id = i.order_id
    WHERE o.event_id = ? AND o.user_id = ? AND i.kind != 'ticket'
      AND o.status IN ('fulfilled', 'refund_pending', 'refund_failed')
    ORDER BY i.id
  `)
  .all(eventId, userId)
  .map((row) => ({
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    kind: row.kind,
    handedOverAt: row.handed_over_at === null ? null : new Date(row.handed_over_at * 1000).toISOString(),
  })));

/**
 * Who is told when the event changes. Staff are on the roster by right of the
 * job, so an organizer editing their own run is not also an attendee to notify
 * about the edit.
 */
const activeParticipantIds = (eventId: number) => Database.useSync((db) => db.select({ userId: registrations.userId })
  .from(registrations)
  .where(and(
    eq(registrations.eventId, eventId),
    inArray(registrations.status, ["registered", "checked_in", "waitlisted"]),
    eq(registrations.isStaff, false),
  ))
  .all()
  .map((row) => row.userId));

/**
 * UnionEnum keeps the literal union intact through Eden's inference, where
 * `t.Union` over a mapped array collapses to `never` on the client.
 *
 * The explicit `default: undefined` is load-bearing: Elysia's UnionEnum sets
 * `default: values[0]` "for generating error message", and the body normaliser
 * then materialises it. Left alone, every PATCH that did not mention a city
 * would arrive carrying `city: "spb"` and quietly move the event to Petersburg —
 * and every role change that did not mention a role would arrive as "admin".
 */
const citySchema = t.UnionEnum(cities, { default: undefined });
const cityRoleSchema = t.UnionEnum(cityRoles, { default: undefined });

const eventFields = t.Object({
  city: citySchema,
  title: t.String({ minLength: 1 }),
  description: t.String(),
  startsAt: t.String(),
  location: t.String({ minLength: 1 }),
  locationUrl: t.Optional(t.Nullable(t.String())),
  capacity: t.Nullable(t.Integer({ minimum: 0 })),
  waitlistEnabled: t.Optional(t.Boolean()),
  remindersEnabled: t.Optional(t.Boolean()),
});

const eventPatchFields = t.Partial(eventFields);
const eventStatus = t.Union([t.Literal("draft"), t.Literal("published"), t.Literal("closed"), t.Literal("canceled")]);
const idParams = t.Object({ id: t.Numeric() });
const ticketTierBody = t.Object({
  id: t.Optional(t.Integer({ minimum: 1 })),
  name: t.String({ minLength: 1, maxLength: 80 }),
  description: t.Optional(t.Nullable(t.String({ maxLength: 160 }))),
  priceMinor: t.Integer({ minimum: 100 }),
  quota: t.Nullable(t.Integer({ minimum: 1 })),
  salesStartAt: t.Optional(t.Nullable(t.String())),
  salesEndAt: t.Optional(t.Nullable(t.String())),
  active: t.Optional(t.Boolean()),
});
const eventProductBody = t.Object({
  id: t.Optional(t.Integer({ minimum: 1 })),
  kind: t.Union([t.Literal("merchandise"), t.Literal("addon")]),
  name: t.String({ minLength: 1, maxLength: 80 }),
  description: t.Optional(t.Nullable(t.String({ maxLength: 240 }))),
  priceMinor: t.Integer({ minimum: 100 }),
  stock: t.Nullable(t.Integer({ minimum: 1 })),
  maxPerOrder: t.Integer({ minimum: 1, maximum: 20 }),
  active: t.Optional(t.Boolean()),
  variants: t.Optional(t.Array(t.Object({
    id: t.Optional(t.Integer({ minimum: 1 })),
    name: t.String({ minLength: 1, maxLength: 40 }),
    stock: t.Nullable(t.Integer({ minimum: 1 })),
    active: t.Optional(t.Boolean()),
  }), { maxItems: 30 })),
});

const seriesFields = t.Object({
  city: citySchema,
  title: t.String({ minLength: 1 }),
  description: t.String(),
  location: t.String({ minLength: 1 }),
  locationUrl: t.Optional(t.Nullable(t.String())),
  capacity: t.Nullable(t.Integer({ minimum: 0 })),
  waitlistEnabled: t.Optional(t.Boolean()),
  remindersEnabled: t.Optional(t.Boolean()),
  homeChatId: t.Optional(t.Nullable(t.Integer())),
  nextStartsAt: t.Nullable(t.String()),
  cadenceDays: t.Nullable(t.Integer({ minimum: 1 })),
  leadDays: t.Optional(t.Integer({ minimum: 0 })),
  active: t.Optional(t.Boolean()),
  groups: t.Optional(t.Array(t.Integer())),
  organizerIds: t.Optional(t.Array(t.Integer())),
});
const seriesCreateBody = seriesFields;
const seriesPatchBody = t.Partial(seriesFields);
const seriesTicketTierBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 80 }),
  description: t.Optional(t.Nullable(t.String({ maxLength: 160 }))),
  priceMinor: t.Integer({ minimum: 100 }),
  quota: t.Nullable(t.Integer({ minimum: 1 })),
  active: t.Optional(t.Boolean()),
});
const seriesProductBody = t.Object({
  kind: t.Union([t.Literal("merchandise"), t.Literal("addon")]),
  name: t.String({ minLength: 1, maxLength: 80 }),
  description: t.Optional(t.Nullable(t.String({ maxLength: 240 }))),
  priceMinor: t.Integer({ minimum: 100 }),
  stock: t.Nullable(t.Integer({ minimum: 1 })),
  maxPerOrder: t.Integer({ minimum: 1, maximum: 20 }),
  active: t.Optional(t.Boolean()),
  variants: t.Optional(t.Array(t.Object({
    name: t.String({ minLength: 1, maxLength: 40 }),
    stock: t.Nullable(t.Integer({ minimum: 1 })),
    active: t.Optional(t.Boolean()),
  }), { maxItems: 30 })),
});

/**
 * The fields only someone who runs the branch may set, merged into one flat object
 * rather than intersected on.
 *
 * An intersection puts each member behind its own `additionalProperties: false`, so
 * once Elysia compiles the route a body carrying `status`, `groups` or `homeChatId`
 * is rejected as an unexpected property by the *other* member — a 422 that only
 * shows up once a route is warm, and so never in a cold test.
 */
const adminFields = {
  status: t.Optional(eventStatus),
  groups: t.Optional(t.Array(t.Integer())),
  homeChatId: t.Optional(t.Nullable(t.Integer())),
};
const eventCreateBody = t.Object({ ...eventFields.properties, ...adminFields });
const eventPatchBody = t.Object({ ...eventPatchFields.properties, ...adminFields });

export const app = new Elysia()
  .get("/api/health", () => ({ ok: true }))
  .post("/api/payments/yookassa/webhook", ({ body, query, status }) => runAsync(Effect.gen(function* () {
    if (!paymentProvider) return error(status, 503, "payments_not_configured");
    if (!env.YOOKASSA_WEBHOOK_SECRET || query.secret !== env.YOOKASSA_WEBHOOK_SECRET) return error(status, 403, "invalid_webhook_secret");
    if (!body || typeof body !== "object" || !("event" in body) || !("object" in body)) return error(status, 400, "invalid_webhook");
    const event = (body as { event?: unknown }).event;
    const object = (body as { object?: unknown }).object;
    if (typeof event !== "string" || !object || typeof object !== "object" || !("id" in object) || typeof object.id !== "string") {
      return error(status, 400, "invalid_webhook");
    }
    const reconcile = event.startsWith("payment.") ? reconcilePayment(object.id, now()).pipe(Effect.map(({ effects }) => effects))
      : event.startsWith("refund.") ? reconcileRefund(object.id, now())
        : null;
    // Failures are not answered here: YooKassa retries a webhook that did not succeed.
    if (reconcile) fireEffects((yield* reconcile.pipe(Effect.provideService(Payments, paymentProvider))));
    return { ok: true };
  })), { body: t.Any(), query: t.Object({ secret: t.String({ minLength: 20 }) }) })
  .group("/api", (api) => api
    .use(auth)
    .get("/me", ({ user, actor }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const isOrganizerOfAny = Boolean(db.select({ eventId: eventOrganizers.eventId }).from(eventOrganizers)
        .where(eq(eventOrganizers.userId, user.id)).get());
      return {
        ...userView(user),
        isOrganizerOfAny,
        roles: [...actor.roles].map(([city, role]) => ({ city, role })),
        adminCities: adminCities(actor),
        organizerCities: organizerCities(actor),
        stats: (yield* runnerStats(user.id)),
      };
    })))
    /** Finished events they held a spot on, newest first — the "done" half of Mine. */
    .get("/me/history", ({ user }) => run(Effect.gen(function* () {
      const db = yield* Database;
      return db.select({ event: events, status: registrations.status, checkedInAt: registrations.checkedInAt })
      .from(registrations).innerJoin(events, eq(registrations.eventId, events.id))
      .where(and(
        eq(registrations.userId, user.id),
        eq(registrations.isStaff, false),
        inArray(registrations.status, ["registered", "checked_in"]),
        sql`${events.endedAt} IS NOT NULL`,
      ))
      .orderBy(desc(events.startsAt)).all()
      .map((row) => ({
        id: row.event.id,
        title: row.event.title,
        city: row.event.city,
        startsAt: row.event.startsAt.toISOString(),
        status: row.status,
        checkedInAt: iso(row.checkedInAt),
      }));
    })))
    .patch("/me", ({ user, body }) => run(Effect.gen(function* () {
      const db = yield* Database;
      db.update(users).set({
        ...(body.locale === undefined ? {} : { locale: body.locale }),
        ...(body.city === undefined ? {} : { city: body.city }),
        ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
        ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
      }).where(eq(users.id, user.id)).run();
      const updated = db.select().from(users).where(eq(users.id, user.id)).get();
      return updated ? userView(updated) : userView(user);
    })), { body: t.Object({ locale: t.Optional(t.Union([t.Literal("ru"), t.Literal("en")])), city: t.Optional(citySchema), firstName: t.Optional(t.String()), lastName: t.Optional(t.String()) }) })
    .get("/events", ({ user }) => runAsync(Effect.gen(function* () {
      const db = yield* Database;
      // Nothing to show until they have said which branch is theirs; the mini app
      // puts the picker up in place of the list rather than guessing.
      if (user.city === null) return [];
      yield* syncMemberships(user.id, (yield* chatsGatingLiveEvents()));
      // A started event stays listed until an organizer ends it, so people can still
      // find it to sign up late or to check in on their way out.
      const listed = db.select().from(events)
        .where(and(eq(events.status, "published"), isNull(events.endedAt), visibleToUser(user.id), inCityForUser(user.city, user.id)))
        .orderBy(asc(events.startsAt)).all();
      return yield* Effect.forEach(listed, Effect.fnUntraced(function* (event) {
        const registration = db.select({ status: registrations.status, isStaff: registrations.isStaff }).from(registrations)
          .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, user.id))).get();
        const offer = db.select({ id: waitlistOffers.id, expiresAt: waitlistOffers.expiresAt }).from(waitlistOffers)
          .where(and(eq(waitlistOffers.eventId, event.id), eq(waitlistOffers.userId, user.id), eq(waitlistOffers.status, "pending")))
          .orderBy(desc(waitlistOffers.offeredAt)).get();
        const confirmedCount = db.select({ value: sql<number>`count(*)` }).from(registrations)
          .where(and(eq(registrations.eventId, event.id), inArray(registrations.status, ["registered", "checked_in"]), eq(registrations.isStaff, false))).get()?.value ?? 0;
        const waitlistSize = db.select({ value: sql<number>`count(*)` }).from(registrations)
          .where(and(eq(registrations.eventId, event.id), eq(registrations.status, "waitlisted"))).get()?.value ?? 0;
        const myWaitlistPosition = registration?.status === "waitlisted" ? (yield* waitlistPositionOf(event.id, user.id)) : null;
        return { ...(yield* eventView(event)), myRegistrationStatus: registration?.status ?? null, myStaffEntry: registration?.isStaff ?? false, myPendingOffer: offer ? { id: offer.id, expiresAt: offer.expiresAt.toISOString() } : null, myWaitlistPosition, confirmedCount, waitlistSize };
      }));
    })))
    .get("/events/:id", ({ params, user, status }) => runAsync(Effect.gen(function* () {
      const db = yield* Database;
      const event = yield* participantEvent(params.id);
      if (!event) return error(status, 404, "event_not_found");
      yield* syncMemberships(user.id, (yield* chatsOfEvent(event.id)));
      // A restricted event stays invisible rather than forbidden — do not leak that it exists.
      if (!(yield* canSeeEvent(event.id, user.id))) return error(status, 404, "event_not_found");
      const registration = db.select({ status: registrations.status, isStaff: registrations.isStaff }).from(registrations)
        .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, user.id))).get();
      const waitlistPosition = registration?.status === "waitlisted" ? (yield* waitlistPositionOf(event.id, user.id)) : null;
      return { ...(yield* eventView(event)), myRegistrationStatus: registration?.status ?? null, myStaffEntry: registration?.isStaff ?? false, myWaitlistPosition: waitlistPosition, organizers: (yield* organizersOf(event.id)) };
    })), { params: idParams })
    .post("/events/:id/join", ({ params, user, status }) => runAsync(Effect.gen(function* () {
      const db = yield* Database;
      if (user.isBanned) return error(status, 403, "banned");
      const paid = db.select({ id: ticketTiers.id }).from(ticketTiers).where(eq(ticketTiers.eventId, params.id)).get();
      if (paid) return error(status, 409, "payment_required");
      return yield* Effect.gen(function* () {
        yield* syncMemberships(user.id, yield* chatsOfEvent(params.id));
        return yield* joinEvent(params.id, user.id, now());
      }).pipe(Effect.catchTag("JoinRejected", ({ code }) => Effect.succeed(
        error(status, code === "already_joined" || code === "event_full" ? 409 : code === "not_eligible" ? 403 : 400, code),
      )));
    })), { params: idParams })
    .post("/events/:id/checkout", ({ params, body, user, status }) => runAsync(Effect.gen(function* () {
      if (user.isBanned) return error(status, 403, "banned");
      if (!paymentProvider) return error(status, 503, "payments_not_configured");
      const provider = paymentProvider;
      return yield* Effect.gen(function* () {
        yield* syncMemberships(user.id, yield* chatsOfEvent(params.id));
        return yield* createCheckout({
          eventId: params.id,
          tierId: body.ticketTierId ?? null,
          productItems: body.items,
          userId: user.id,
          userPhone: user.phone,
          returnUrl: `https://${env.DOMAIN}/events/${params.id}`,
        }, now()).pipe(
          Effect.provideService(Payments, provider),
          Effect.catchDefect((cause) => Effect.sync(() => {
            console.error("YooKassa checkout creation failed", cause instanceof Error ? cause.message : "unknown error");
            return error(status, 503, "payment_temporarily_unavailable");
          })),
        );
      }).pipe(Effect.catchTag("CheckoutRejected", ({ code }) => Effect.succeed(error(status, code === "not_eligible" ? 403
        : ["already_joined", "ticket_sold_out", "product_sold_out", "event_full", "active_order_exists"].includes(code) ? 409
          : code === "event_not_found" ? 404 : 400, code))));
    })), {
      params: idParams,
      body: t.Object({
        ticketTierId: t.Optional(t.Nullable(t.Integer({ minimum: 1 }))),
        items: t.Optional(t.Array(t.Object({
          productId: t.Integer({ minimum: 1 }),
          variantId: t.Optional(t.Nullable(t.Integer({ minimum: 1 }))),
          quantity: t.Integer({ minimum: 1, maximum: 20 }),
        }), { maxItems: 20 })),
      }),
    })
    .get("/orders/:id", ({ params, user, status }) => run(Effect.gen(function* () {
      const order = yield* orderForUser(params.id, user.id);
      return order ?? error(status, 404, "order_not_found");
    })), { params: t.Object({ id: t.String({ minLength: 1 }) }) })
    .get("/orders", ({ user }) => run(Effect.gen(function* () {
      return (yield* ordersForUser(user.id));
    })))
    .post("/orders/:id/cancel", ({ params, user, status }) => runAsync(Effect.gen(function* () {
      return (yield* cancelPendingOrder(params.id, user.id, now()).pipe(
      Effect.catchTag("OrderRejected", ({ code }) => Effect.succeed(error(status, code === "order_not_found" ? 404 : 409, code))),
      Effect.catchDefect((cause) => Effect.sync(() => {
        console.error(`Payment abandonment failed for order ${params.id}`, cause instanceof Error ? cause.message : "unknown error");
        return error(status, 503, "payment_temporarily_unavailable");
      })),
    ));
    })), { params: t.Object({ id: t.String({ minLength: 1 }) }) })
    .post("/events/:id/cancel", ({ params, user, status }) => runAsync(Effect.gen(function* () {
      const db = yield* Database;
      if (user.isBanned) return error(status, 403, "banned");
      if (!(yield* participantEvent(params.id))) return error(status, 404, "event_not_found");
      const paidOrder = db.select({ id: ticketOrders.id }).from(ticketOrders)
        .where(and(
          eq(ticketOrders.eventId, params.id),
          eq(ticketOrders.userId, user.id),
          sql`${ticketOrders.ticketTierId} IS NOT NULL`,
          inArray(ticketOrders.status, ["fulfilled", "refund_pending", "refund_failed"]),
        )).get();
      if (paidOrder) {
        if (!paymentProvider) return error(status, 503, "payments_not_configured");
        return yield* requestUserRefund(params.id, user.id, now()).pipe(
          Effect.provideService(Payments, paymentProvider),
          Effect.map((effects) => {
            fireEffects(effects ?? []);
            return { ok: true, refundPending: true };
          }),
          Effect.catchDefect((cause) => Effect.sync(() => {
            console.error(`YooKassa refund creation failed for order ${paidOrder.id}`, cause instanceof Error ? cause.message : "unknown error");
            const pending = db.select({ status: ticketOrders.status }).from(ticketOrders).where(eq(ticketOrders.id, paidOrder.id)).get();
            return pending?.status === "refund_pending"
              ? { ok: true, refundPending: true }
              : error(status, 503, "payment_temporarily_unavailable");
          })),
        );
      }
      fireEffects((yield* cancelRegistration(params.id, user.id, now())).effects);
      return { ok: true, refundPending: false };
    })), { params: idParams })
    .post("/offers/:id/accept", ({ params, user, status }) => run(Effect.gen(function* () {
      if (user.isBanned) return error(status, 403, "banned");
      return yield* acceptOffer(params.id, user.id, now()).pipe(
        Effect.map(({ effects }) => {
          fireEffects(effects);
          return { ok: true };
        }),
        Effect.catchTag("OfferRejected", ({ code }) => Effect.succeed(error(status, 409, code))),
      );
    })), { params: idParams })
    .post("/checkin", ({ body, user, status }) => run(Effect.gen(function* () {
      if (user.isBanned) return error(status, 403, "banned");
      const token = verifyCheckinToken(env.CHECKIN_SECRET, body.code, now());
      if (!token) return error(status, 400, "invalid_or_stale_code");
      if ((yield* isPaidEvent(token.eventId))) return error(status, 409, "ticketed_event");
      return yield* checkIn(token.eventId, user.id, now()).pipe(
        Effect.catchTag("CheckinRejected", ({ code }) => Effect.succeed(error(status, 400, code))),
      );
    })), { body: t.Object({ code: t.String({ minLength: 1 }) }) })
    /** Staff mark themselves arrived instead of scanning the code they are there to show. */
    .post("/events/:id/turn-in", ({ params, user, status }) => run(Effect.gen(function* () {
      if (user.isBanned) return error(status, 403, "banned");
      return yield* turnIn(params.id, user.id, now()).pipe(
        Effect.catchTag("CheckinRejected", ({ code }) => Effect.succeed(error(status, code === "not_staff" ? 403 : 400, code))),
      );
    })), { params: idParams })
    /**
     * The ticket a runner shows at the door. Deliberately not a
     * checked-in/not-checked-in gate: someone who has already been scanned may
     * still be owed a hoodie, so the ticket keeps working and keeps listing
     * what they came to collect.
     */
    .get("/events/:id/ticket", ({ params, user, status }) => runAsync(Effect.gen(function* () {
      const db = yield* Database;
      const event = yield* participantEvent(params.id);
      if (!event) return error(status, 404, "event_not_found");
      yield* syncMemberships(user.id, (yield* chatsOfEvent(event.id)));
      if (!(yield* canSeeEvent(event.id, user.id))) return error(status, 404, "event_not_found");
      if (!(yield* isPaidEvent(event.id))) return error(status, 409, "not_ticketed");
      const registration = db.select({ id: registrations.id, status: registrations.status }).from(registrations)
        .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, user.id))).get();
      if (!registration || (registration.status !== "registered" && registration.status !== "checked_in")) {
        return error(status, 403, "not_registered");
      }
      return {
        token: mintTicketToken(env.CHECKIN_SECRET, event.id, user.id),
        number: registration.id,
        status: registration.status,
        ticketName: (yield* ticketNameFor(event.id, user.id)),
        items: (yield* purchaseLines(event.id, user.id)),
      };
    })), { params: idParams })

    .get("/organizer/series", ({ user, isAdmin, actor }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const listView = Effect.fnUntraced(function* (series: typeof eventSeries.$inferSelect) {
        return { ...seriesView(series), ...(yield* seriesSummary(series.id, now())) };
      });
      if (isAdmin) return yield* Effect.forEach(db.select().from(eventSeries).orderBy(desc(eventSeries.nextStartsAt), desc(eventSeries.id)).all(), listView);
      const runs = adminCities(actor);
      const byCity = runs.length
        ? db.select().from(eventSeries).where(inArray(eventSeries.city, runs)).all()
        : [];
      const byName = db.select({ series: eventSeries }).from(seriesOrganizers)
        .innerJoin(eventSeries, eq(seriesOrganizers.seriesId, eventSeries.id))
        .where(eq(seriesOrganizers.userId, user.id)).all().map((row) => row.series);
      const merged = new Map([...byCity, ...byName].map((series) => [series.id, series]));
      return yield* Effect.forEach([...merged.values()]
        .sort((a, b) => (b.nextStartsAt?.getTime() ?? 0) - (a.nextStartsAt?.getTime() ?? 0) || b.id - a.id), listView);
    })))
    .post("/organizer/series", ({ body, user, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      if (!canAdminCity(actor, body.city)) return error(status, 403, "forbidden");
      const nextStartsAt = body.nextStartsAt === null ? null : parseDate(body.nextStartsAt);
      if (nextStartsAt === undefined) return error(status, 400, "invalid_next_starts_at");
      const locationUrl = body.locationUrl === undefined ? null : parseLocationUrl(body.locationUrl);
      if (locationUrl === undefined) return error(status, 400, "invalid_location_url");
      if (body.groups && (yield* unknownGroup(body.city, body.groups))) return error(status, 400, "unknown_group");
      if ((yield* unknownHomeChat(body.city, body.homeChatId))) return error(status, 400, "unknown_home_chat");
      const groups = [...new Set(body.groups ?? [])];
      const organizerIds = [...new Set(body.organizerIds ?? [])];
      const created = db.$client.transaction(() => {
        const series = db.insert(eventSeries).values({
          city: body.city,
          title: body.title,
          description: body.description,
          location: body.location,
          locationUrl,
          capacity: body.capacity,
          waitlistEnabled: body.waitlistEnabled,
          remindersEnabled: body.remindersEnabled,
          homeChatId: body.homeChatId,
          nextStartsAt,
          cadenceDays: body.cadenceDays,
          leadDays: body.leadDays,
          active: body.active,
          createdBy: user.id,
        }).returning().get();
        for (const chatId of groups) db.insert(seriesChats).values({ seriesId: series.id, chatId }).run();
        for (const userId of organizerIds) db.insert(seriesOrganizers).values({ seriesId: series.id, userId }).run();
        return series;
      })();
      return seriesView(created);
    })), { body: seriesCreateBody })
    .get("/organizer/series/:id", ({ params, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageableSeries(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const occurrenceRows = db.select().from(events).where(eq(events.seriesId, params.id)).orderBy(asc(events.startsAt), asc(events.id)).all();
      const boundary = now().getTime();
      return {
        ...seriesView(found.series),
        groups: db.select({ chatId: seriesChats.chatId }).from(seriesChats)
          .where(eq(seriesChats.seriesId, params.id)).orderBy(asc(seriesChats.chatId)).all().map((row) => row.chatId),
        organizerIds: db.select({ userId: seriesOrganizers.userId }).from(seriesOrganizers)
          .where(eq(seriesOrganizers.seriesId, params.id)).orderBy(asc(seriesOrganizers.userId)).all().map((row) => row.userId),
        // Names for the template's "led by" and "chat" lines.
        organizers: db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(seriesOrganizers)
          .innerJoin(users, eq(seriesOrganizers.userId, users.id))
          .where(eq(seriesOrganizers.seriesId, params.id)).orderBy(asc(users.firstName)).all(),
        chats: yield* Effect.forEach(db.select({ chatId: seriesChats.chatId }).from(seriesChats).where(eq(seriesChats.seriesId, params.id)).all(),
          (row) => namedChat(row.chatId)),
        ticketTiers: db.select().from(seriesTicketTiers).where(eq(seriesTicketTiers.seriesId, params.id))
          .orderBy(asc(seriesTicketTiers.sortOrder), asc(seriesTicketTiers.id)).all().map(seriesTierView),
        products: yield* Effect.forEach(db.select().from(seriesProducts).where(eq(seriesProducts.seriesId, params.id))
          .orderBy(asc(seriesProducts.sortOrder), asc(seriesProducts.id)).all(), seriesProductView),
        upcomingOccurrences: yield* Effect.forEach(occurrenceRows.filter((event) => event.startsAt.getTime() >= boundary), eventView),
        pastOccurrences: yield* Effect.forEach(occurrenceRows.filter((event) => event.startsAt.getTime() < boundary), eventView),
      };
    })), { params: idParams })
    .patch("/organizer/series/:id", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageableSeries(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const targetCity = body.city ?? found.series.city;
      if (body.city !== undefined && body.city !== found.series.city && !canAdminCity(actor, body.city)) {
        return error(status, 403, "forbidden");
      }
      const nextStartsAt = body.nextStartsAt === undefined
        ? undefined
        : body.nextStartsAt === null ? null : parseDate(body.nextStartsAt);
      if (body.nextStartsAt !== undefined && nextStartsAt === undefined) return error(status, 400, "invalid_next_starts_at");
      const locationUrl = body.locationUrl === undefined ? undefined : parseLocationUrl(body.locationUrl);
      if (body.locationUrl !== undefined && locationUrl === undefined) return error(status, 400, "invalid_location_url");
      if (body.groups && (yield* unknownGroup(targetCity, body.groups))) return error(status, 400, "unknown_group");
      if ((yield* unknownHomeChat(targetCity, body.homeChatId))) return error(status, 400, "unknown_home_chat");
      if (body.organizerIds && unknownUserIds(db, body.organizerIds)) return error(status, 400, "user_not_found");
      db.$client.transaction(() => {
        db.update(eventSeries).set({
          ...(body.city === undefined ? {} : { city: body.city }),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.location === undefined ? {} : { location: body.location }),
          ...(locationUrl === undefined ? {} : { locationUrl }),
          ...(body.capacity === undefined ? {} : { capacity: body.capacity }),
          ...(body.homeChatId === undefined ? {} : { homeChatId: body.homeChatId }),
          ...(nextStartsAt === undefined ? {} : { nextStartsAt }),
          ...(body.cadenceDays === undefined ? {} : { cadenceDays: body.cadenceDays }),
          ...(body.leadDays === undefined ? {} : { leadDays: body.leadDays }),
          ...(body.active === undefined ? {} : { active: body.active }),
          updatedAt: now(),
        }).where(eq(eventSeries.id, params.id)).run();
        if (body.groups !== undefined) {
          db.delete(seriesChats).where(eq(seriesChats.seriesId, params.id)).run();
          for (const chatId of [...new Set(body.groups)]) db.insert(seriesChats).values({ seriesId: params.id, chatId }).run();
        }
      })();
      // Leads, the queue and reminders also reach the runs already raised and still ahead.
      if (body.organizerIds !== undefined) yield* setSeriesLeads(params.id, body.organizerIds, now()).pipe(Effect.orDie);
      if (body.waitlistEnabled !== undefined) {
        fireEffects((yield* setSeriesWaitlist(params.id, body.waitlistEnabled, now()).pipe(Effect.orDie)).effects);
      }
      if (body.remindersEnabled !== undefined) yield* setSeriesReminders(params.id, body.remindersEnabled, now()).pipe(Effect.orDie);
      const updated = db.select().from(eventSeries).where(eq(eventSeries.id, params.id)).get();
      return updated ? seriesView(updated) : error(status, 404, "series_not_found");
    })), { params: idParams, body: seriesPatchBody })
    .post("/organizer/series/:id/spawn", ({ params, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageableSeries(actor, params.id, true);
      if (found.denied) return error(status, found.code, found.denied);
      return yield* spawnOccurrence(params.id, now()).pipe(
        Effect.flatMap(Effect.fnUntraced(function* ({ eventId }) {
          const event = db.select().from(events).where(eq(events.id, eventId)).get();
          return event ? yield* eventView(event) : error(status, 404, "event_not_found");
        })),
        Effect.catchTag("SeriesRejected", ({ code }) => Effect.succeed(error(status, code === "series_not_found" ? 404 : 409, code))),
      );
    })), { params: idParams })
    .post("/organizer/series/:id/skip", ({ params, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageableSeries(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      return yield* skipNext(params.id, now()).pipe(
        Effect.map(() => {
          const updated = db.select().from(eventSeries).where(eq(eventSeries.id, params.id)).get();
          return updated ? seriesView(updated) : error(status, 404, "series_not_found");
        }),
        Effect.catchTag("SeriesRejected", ({ code }) => Effect.succeed(error(status, code === "series_not_found" ? 404 : 409, code))),
      );
    })), { params: idParams })
    .get("/organizer/series/:id/stats", ({ params, actor, status }) => run(Effect.gen(function* () {
      const found = yield* manageableSeries(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const stats = yield* seriesStats(params.id);
      return {
        ...stats,
        occurrences: stats.occurrences.map((occurrence) => ({
          ...occurrence,
          startsAt: occurrence.startsAt.toISOString(),
        })),
      };
    })), { params: idParams })
    .put("/organizer/series/:id/ticket-tiers", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageableSeries(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const parsed = body.tiers.map((tier) => ({ ...tier, name: tier.name.trim() }));
      if (parsed.some((tier) => !tier.name)) return error(status, 400, "invalid_ticket_tier");
      db.$client.transaction(() => {
        db.delete(seriesTicketTiers).where(eq(seriesTicketTiers.seriesId, params.id)).run();
        parsed.forEach((tier, sortOrder) => db.insert(seriesTicketTiers).values({
          seriesId: params.id,
          name: tier.name,
          description: tier.description?.trim() || null,
          priceMinor: tier.priceMinor,
          quota: tier.quota,
          active: tier.active ?? true,
          sortOrder,
        }).run());
      })();
      return { tiers: db.select().from(seriesTicketTiers).where(eq(seriesTicketTiers.seriesId, params.id))
        .orderBy(asc(seriesTicketTiers.sortOrder), asc(seriesTicketTiers.id)).all().map(seriesTierView) };
    })), { params: idParams, body: t.Object({ tiers: t.Array(seriesTicketTierBody, { maxItems: 20 }) }) })
    .put("/organizer/series/:id/products", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageableSeries(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const parsed = body.products.map((product) => ({
        ...product,
        name: product.name.trim(),
        description: product.description?.trim() || null,
        variants: product.variants?.map((variant) => ({ ...variant, name: variant.name.trim() })),
      }));
      if (parsed.some((product) => !product.name || product.variants?.some((variant) => !variant.name))) {
        return error(status, 400, "invalid_product");
      }
      if (parsed.some((product) => {
        const names = product.variants?.map((variant) => variant.name.toLocaleLowerCase()) ?? [];
        return new Set(names).size !== names.length;
      })) return error(status, 400, "duplicate_product_variant");
      db.$client.transaction(() => {
        db.delete(seriesProducts).where(eq(seriesProducts.seriesId, params.id)).run();
        parsed.forEach((product, sortOrder) => {
          const productId = db.insert(seriesProducts).values({
            seriesId: params.id,
            kind: product.kind,
            name: product.name,
            description: product.description,
            priceMinor: product.priceMinor,
            stock: product.variants?.length ? null : product.stock,
            maxPerOrder: product.maxPerOrder,
            active: product.active ?? true,
            sortOrder,
          }).returning({ id: seriesProducts.id }).get().id;
          product.variants?.forEach((variant, variantSortOrder) => db.insert(seriesProductVariants).values({
            productId,
            name: variant.name,
            stock: variant.stock,
            active: variant.active ?? true,
            sortOrder: variantSortOrder,
          }).run());
        });
      })();
      return { products: yield* Effect.forEach(db.select().from(seriesProducts).where(eq(seriesProducts.seriesId, params.id))
        .orderBy(asc(seriesProducts.sortOrder), asc(seriesProducts.id)).all(), seriesProductView) };
    })), { params: idParams, body: t.Object({ products: t.Array(seriesProductBody, { maxItems: 40 }) }) })

    .get("/organizer/events", ({ user, isAdmin, actor }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const listView = Effect.fnUntraced(function* (event: typeof events.$inferSelect) {
        return { ...(yield* eventView(event)), phase: eventPhase(event, now()) };
      });
      if (isAdmin) return yield* Effect.forEach(db.select().from(events).orderBy(desc(events.startsAt)).all(), listView);
      // Everything in the branches they run, plus every event they are named on
      // elsewhere — the two overlap, so they are merged rather than concatenated.
      const runs = adminCities(actor);
      const byCity = runs.length
        ? db.select().from(events).where(inArray(events.city, runs)).orderBy(desc(events.startsAt)).all()
        : [];
      const byName = db.select({ event: events }).from(eventOrganizers)
        .innerJoin(events, eq(eventOrganizers.eventId, events.id))
        .where(eq(eventOrganizers.userId, user.id)).orderBy(desc(events.startsAt)).all().map((row) => row.event);
      const merged = new Map([...byCity, ...byName].map((event) => [event.id, event]));
      return yield* Effect.forEach([...merged.values()].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()), listView);
    })))
    /**
     * Raising an event is an organizer's job, not an admin's — a branch organizer
     * exists precisely so someone can put a run on without the club's keys. The
     * fields that reach beyond the event itself stay admin-only, as they were.
     */
    .post("/organizer/events", ({ body, user, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      if (!canCreateEventIn(actor, body.city)) return error(status, 403, "forbidden");
      const startsAt = parseDate(body.startsAt);
      if (!startsAt) return error(status, 400, "invalid_starts_at");
      const locationUrl = body.locationUrl === undefined ? null : parseLocationUrl(body.locationUrl);
      if (locationUrl === undefined) return error(status, 400, "invalid_location_url");
      const asAdmin = canAdminCity(actor, body.city);
      if (!asAdmin && (body.groups?.length || body.homeChatId != null || body.status !== undefined)) {
        return error(status, 403, "forbidden");
      }
      if (body.groups && (yield* unknownGroup(body.city, body.groups))) return error(status, 400, "unknown_group");
      if ((yield* unknownHomeChat(body.city, body.homeChatId))) return error(status, 400, "unknown_home_chat");
      const { groups, ...fields } = body;
      const created = db.$client.transaction(() => {
        const row = db.insert(events).values({ ...fields, locationUrl, startsAt, createdBy: user.id, status: body.status ?? "draft" }).returning().get();
        // Whoever raised it runs it, or they could not reopen the form they just left.
        db.insert(eventOrganizers).values({ eventId: row.id, userId: user.id }).onConflictDoNothing().run();
        return row;
      })();
      yield* Effect.gen(function* () {
        if (groups) yield* setEventChats(created.id, groups);
        yield* syncEventStaff(created.id, now());
      });
      return yield* eventView(created);
    })), { body: eventCreateBody })
    .patch("/organizer/events/:id", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const { event } = found;
      const startsAt = body.startsAt === undefined ? undefined : parseDate(body.startsAt);
      if (body.startsAt !== undefined && !startsAt) return error(status, 400, "invalid_starts_at");
      const locationUrl = body.locationUrl === undefined ? undefined : parseLocationUrl(body.locationUrl);
      if (body.locationUrl !== undefined && locationUrl === undefined) return error(status, 400, "invalid_location_url");
      const changes: EventChange[] = [
        body.title !== undefined && body.title !== event.title ? "title" : null,
        body.description !== undefined && body.description !== event.description ? "description" : null,
        startsAt !== undefined && startsAt.getTime() !== event.startsAt.getTime() ? "startsAt" : null,
        (body.location !== undefined && body.location !== event.location) || (locationUrl !== undefined && locationUrl !== event.locationUrl) ? "location" : null,
        body.capacity !== undefined && body.capacity !== event.capacity ? "capacity" : null,
      ].filter((change): change is EventChange => change !== null);
      if (body.title !== undefined || body.description !== undefined || startsAt !== undefined || body.location !== undefined || locationUrl !== undefined || body.waitlistEnabled !== undefined || body.remindersEnabled !== undefined) {
        db.update(events).set({
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(startsAt === undefined ? {} : { startsAt }),
          ...(body.location === undefined ? {} : { location: body.location }),
          ...(locationUrl === undefined ? {} : { locationUrl }),
          ...(body.waitlistEnabled === undefined ? {} : { waitlistEnabled: body.waitlistEnabled }),
          ...(body.remindersEnabled === undefined ? {} : { remindersEnabled: body.remindersEnabled }),
          updatedAt: now(),
        }).where(eq(events.id, params.id)).run();
      }
      if (body.capacity !== undefined) fireEffects((yield* setCapacity(params.id, body.capacity, now())));
      // Switching the queue back on hands out the spots the dormant queue missed.
      if (body.waitlistEnabled === true && !event.waitlistEnabled) fireEffects((yield* issueOffers(params.id, now())));
      if (event.status !== "draft" && changes.length) background(notifyEventUpdated((yield* activeParticipantIds(params.id)), params.id, changes));
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? (yield* eventView(updated)) : error(status, 404, "event_not_found");
    })), { params: idParams, body: eventPatchFields })
    .put("/organizer/events/:id/ticket-tiers", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const parsed = body.tiers.map((tier) => ({
        ...tier,
        name: tier.name.trim(),
        salesStartAt: tier.salesStartAt == null ? null : parseDate(tier.salesStartAt),
        salesEndAt: tier.salesEndAt == null ? null : parseDate(tier.salesEndAt),
      }));
      if (parsed.some((tier) => !tier.name || tier.salesStartAt === undefined || tier.salesEndAt === undefined)) {
        return error(status, 400, "invalid_ticket_tier");
      }
      if (parsed.some((tier) => tier.salesStartAt && tier.salesEndAt && tier.salesStartAt >= tier.salesEndAt)) {
        return error(status, 400, "invalid_sales_window");
      }
      const ids = parsed.flatMap((tier) => tier.id === undefined ? [] : [tier.id]);
      if (new Set(ids).size !== ids.length) return error(status, 400, "duplicate_ticket_tier");
      if (ids.length) {
        const owned = db.select({ id: ticketTiers.id }).from(ticketTiers)
          .where(and(eq(ticketTiers.eventId, params.id), inArray(ticketTiers.id, ids))).all();
        if (owned.length !== ids.length) return error(status, 400, "ticket_not_found");
      }
      for (const tier of parsed) {
        if (tier.id === undefined || tier.quota === null) continue;
        const claimed = db.select({ value: sql<number>`count(*)` }).from(ticketOrders)
          .where(and(eq(ticketOrders.ticketTierId, tier.id), inArray(ticketOrders.status, ["awaiting_payment", "payment_succeeded", "fulfilled", "refund_pending", "refund_failed"]))).get()?.value ?? 0;
        if (tier.quota < claimed) return error(status, 409, "ticket_quota_below_claimed");
      }
      db.$client.transaction(() => {
        db.update(ticketTiers).set({ active: false, updatedAt: now() }).where(eq(ticketTiers.eventId, params.id)).run();
        // A dropped tier nobody ever bought leaves no trace, so a draft switched back
        // to free really is free again ("no rows means the event is free").
        db.delete(ticketTiers).where(and(
          eq(ticketTiers.eventId, params.id),
          ids.length ? sql`${ticketTiers.id} NOT IN ${ids}` : undefined,
          sql`NOT EXISTS (SELECT 1 FROM ticket_orders o WHERE o.ticket_tier_id = ${ticketTiers.id})`,
          sql`NOT EXISTS (SELECT 1 FROM order_items i WHERE i.ticket_tier_id = ${ticketTiers.id})`,
        )).run();
        parsed.forEach((tier, sortOrder) => {
          const values = {
            name: tier.name,
            description: tier.description?.trim() || null,
            priceMinor: tier.priceMinor,
            quota: tier.quota,
            salesStartAt: tier.salesStartAt,
            salesEndAt: tier.salesEndAt,
            active: tier.active ?? true,
            sortOrder,
            updatedAt: now(),
          };
          if (tier.id === undefined) db.insert(ticketTiers).values({ eventId: params.id, ...values }).run();
          else db.update(ticketTiers).set(values).where(eq(ticketTiers.id, tier.id)).run();
        });
      })();
      const event = db.select().from(events).where(eq(events.id, params.id)).get();
      return event ? (yield* eventView(event)) : error(status, 404, "event_not_found");
    })), { params: idParams, body: t.Object({ tiers: t.Array(ticketTierBody, { maxItems: 20 }) }) })
    .put("/organizer/events/:id/products", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const parsed = body.products.map((product) => ({
        ...product,
        name: product.name.trim(),
        description: product.description?.trim() || null,
        variants: product.variants?.map((variant) => ({ ...variant, name: variant.name.trim() })),
      }));
      if (parsed.some((product) => !product.name || product.variants?.some((variant) => !variant.name))) {
        return error(status, 400, "invalid_product");
      }
      if (parsed.some((product) => {
        const names = product.variants?.map((variant) => variant.name.toLocaleLowerCase()) ?? [];
        return new Set(names).size !== names.length;
      })) return error(status, 400, "duplicate_product_variant");
      const ids = parsed.flatMap((product) => product.id === undefined ? [] : [product.id]);
      if (new Set(ids).size !== ids.length) return error(status, 400, "duplicate_product");
      if (ids.length) {
        const owned = db.select({ id: eventProducts.id }).from(eventProducts)
          .where(and(eq(eventProducts.eventId, params.id), inArray(eventProducts.id, ids))).all();
        if (owned.length !== ids.length) return error(status, 400, "product_not_found");
      }
      const variantIds = parsed.flatMap((product) => product.variants?.flatMap((variant) => variant.id === undefined ? [] : [variant.id]) ?? []);
      if (new Set(variantIds).size !== variantIds.length) return error(status, 400, "duplicate_product_variant");
      if (variantIds.length) {
        const owned = db.select({ id: eventProductVariants.id }).from(eventProductVariants)
          .innerJoin(eventProducts, eq(eventProducts.id, eventProductVariants.productId))
          .where(and(eq(eventProducts.eventId, params.id), inArray(eventProductVariants.id, variantIds))).all();
        if (owned.length !== variantIds.length) return error(status, 400, "product_variant_not_found");
      }
      for (const product of parsed) {
        const productVariantIds = product.variants?.flatMap((variant) => variant.id === undefined ? [] : [variant.id]) ?? [];
        if (productVariantIds.length && product.id === undefined) return error(status, 400, "product_variant_not_found");
        if (productVariantIds.length) {
          const owned = db.select({ id: eventProductVariants.id }).from(eventProductVariants)
            .where(and(eq(eventProductVariants.productId, product.id!), inArray(eventProductVariants.id, productVariantIds))).all();
          if (owned.length !== productVariantIds.length) return error(status, 400, "product_variant_not_found");
        }
      }
      for (const product of parsed) {
        if (product.id === undefined) continue;
        const claimed = db.$client.query<{ value: number | null }, [number]>(`
          SELECT sum(i.quantity) AS value FROM order_items i
          JOIN ticket_orders o ON o.id = i.order_id
          WHERE i.event_product_id = ?
            AND o.status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
        `).get(product.id)?.value ?? 0;
        const existingHasVariants = Boolean(db.select({ id: eventProductVariants.id }).from(eventProductVariants)
          .where(eq(eventProductVariants.productId, product.id)).get());
        if (product.variants !== undefined && claimed > 0 && existingHasVariants !== (product.variants.length > 0)) {
          return error(status, 409, "product_variants_locked");
        }
        if (product.variants?.length) {
          for (const variant of product.variants) {
            if (variant.id === undefined || variant.stock === null) continue;
            const variantClaimed = db.$client.query<{ value: number | null }, [number]>(`
              SELECT sum(i.quantity) AS value FROM order_items i
              JOIN ticket_orders o ON o.id = i.order_id
              WHERE i.event_product_variant_id = ?
                AND o.status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
            `).get(variant.id)?.value ?? 0;
            if (variant.stock < variantClaimed) return error(status, 409, "product_stock_below_claimed");
          }
        } else if (product.stock !== null && product.stock < claimed) {
          return error(status, 409, "product_stock_below_claimed");
        }
      }
      db.$client.transaction(() => {
        db.update(eventProducts).set({ active: false, updatedAt: now() }).where(eq(eventProducts.eventId, params.id)).run();
        // Same for merch: an unsold item that was taken off leaves the event free.
        db.delete(eventProducts).where(and(
          eq(eventProducts.eventId, params.id),
          ids.length ? sql`${eventProducts.id} NOT IN ${ids}` : undefined,
          sql`NOT EXISTS (SELECT 1 FROM order_items i WHERE i.event_product_id = ${eventProducts.id})`,
        )).run();
        parsed.forEach((product, sortOrder) => {
          const values = {
            kind: product.kind,
            name: product.name,
            description: product.description,
            priceMinor: product.priceMinor,
            stock: product.variants?.length ? null : product.stock,
            maxPerOrder: product.maxPerOrder,
            active: product.active ?? true,
            sortOrder,
            updatedAt: now(),
          };
          const productId = product.id === undefined
            ? db.insert(eventProducts).values({ eventId: params.id, ...values }).returning({ id: eventProducts.id }).get().id
            : product.id;
          if (product.id !== undefined) db.update(eventProducts).set(values).where(eq(eventProducts.id, product.id)).run();
          if (product.variants !== undefined) {
            db.update(eventProductVariants).set({ active: false, updatedAt: now() })
              .where(eq(eventProductVariants.productId, productId)).run();
            product.variants.forEach((variant, variantSortOrder) => {
              const variantValues = {
                name: variant.name,
                stock: variant.stock,
                active: variant.active ?? true,
                sortOrder: variantSortOrder,
                updatedAt: now(),
              };
              if (variant.id === undefined) db.insert(eventProductVariants).values({ productId, ...variantValues }).run();
              else db.update(eventProductVariants).set(variantValues).where(eq(eventProductVariants.id, variant.id)).run();
            });
          }
        });
      })();
      const event = db.select().from(events).where(eq(events.id, params.id)).get();
      return event ? (yield* eventView(event)) : error(status, 404, "event_not_found");
    })), { params: idParams, body: t.Object({ products: t.Array(eventProductBody, { maxItems: 40 }) }) })
    .get("/organizer/events/:id/attendance", ({ params, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      // The roster is the one screen that must never be stale about who is on it,
      // and it is cheap to reconcile: a no-op once the rows are there.
      yield* syncEventStaff(params.id, now());
      const flags = yield* rosterFlags(params.id);
      const attendance = db.select({
        userId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        username: users.username,
        phone: users.phone,
        status: registrations.status,
        isStaff: registrations.isStaff,
        checkedInAt: registrations.checkedInAt,
        checkinMethod: registrations.checkinMethod,
        ticketName: sql<string | null>`(
          SELECT o.ticket_name FROM ticket_orders o
          WHERE o.event_id = ${params.id} AND o.user_id = ${users.id} AND o.ticket_tier_id IS NOT NULL
          ORDER BY o.created_at DESC LIMIT 1
        )`,
        paymentStatus: sql<string | null>`(
          SELECT o.status FROM ticket_orders o
          WHERE o.event_id = ${params.id} AND o.user_id = ${users.id} AND o.ticket_tier_id IS NOT NULL
          ORDER BY o.created_at DESC LIMIT 1
        )`,
      })
        // Staff sit under the people the run is actually for.
        .from(registrations).innerJoin(users, eq(registrations.userId, users.id)).where(eq(registrations.eventId, params.id)).orderBy(asc(registrations.isStaff), asc(registrations.createdAt)).all();
      const roster = yield* Effect.forEach(attendance, Effect.fnUntraced(function* (row) {
        return {
          ...row,
          checkedInAt: iso(row.checkedInAt),
          checkinMethod: checkinMethodOf(row.status, row.checkinMethod),
          ...flags(row.userId),
          purchaseItems: yield* purchaseLines(params.id, row.userId),
        };
      }));
      return { registrations: roster, counts: yield* eventStats(params.id), ticketed: yield* isPaidEvent(params.id) };
    })), { params: idParams })
    .get("/organizer/events/:id/checkin-token", ({ params, actor, status }) => run(Effect.gen(function* () {
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      // No point showing a code nobody's scan would be accepted from.
      if ((yield* isEventOver(params.id))) return error(status, 409, "event_over");
      // Paid runs go the other way round — the runner holds the ticket and the
      // organizer scans it. Refused here, not merely hidden in the mini app, so
      // the two doors cannot drift apart.
      if ((yield* isPaidEvent(params.id))) return error(status, 409, "ticketed_event");
      return { token: mintCheckinToken(env.CHECKIN_SECRET, params.id, now()), expiresInSeconds: 45 };
    })), { params: idParams })
    /**
     * The door scan on a paid run. A ticket that has already been through is
     * answered, not rejected: the organizer still needs the name on screen and
     * the merch lines to tick off, and a second scan is how they get them back.
     */
    .post("/organizer/events/:id/scan", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const ticket = verifyTicketToken(env.CHECKIN_SECRET, body.code);
      if (!ticket) return error(status, 400, "invalid_ticket");
      // Someone else's event, or last week's — say so plainly rather than "invalid".
      if (ticket.eventId !== params.id) return error(status, 409, "wrong_event");
      return yield* scanTicket(params.id, ticket.userId, now()).pipe(
        Effect.flatMap(Effect.fnUntraced(function* (result) {
          const person = db.select().from(users).where(eq(users.id, ticket.userId)).get();
          if (!person) return error(status, 404, "event_not_found");
          return {
            userId: person.id,
            firstName: person.firstName,
            lastName: person.lastName,
            username: person.username,
            phone: person.phone,
            ticketName: yield* ticketNameFor(params.id, person.id),
            // The same number the runner sees on their ticket.
            number: db.select({ id: registrations.id }).from(registrations)
              .where(and(eq(registrations.eventId, params.id), eq(registrations.userId, person.id))).get()?.id ?? null,
            alreadyCheckedIn: result.alreadyCheckedIn,
            checkedInAt: result.checkedInAt.toISOString(),
            items: yield* purchaseLines(params.id, person.id),
          };
        })),
        Effect.catchTag("CheckinRejected", ({ code }) => Effect.succeed(error(status, code === "event_over" ? 409 : 400, code))),
      );
    })), { params: idParams, body: t.Object({ code: t.String({ minLength: 1 }) }) })
    /** Ticking one merch line off — from the scan panel, or later from the roster. */
    .post("/organizer/events/:id/items/:itemId/handover", ({ params, user, actor, status }) => run(Effect.gen(function* () {
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      return yield* toggleHandover(params.id, params.itemId, user.id, now()).pipe(
        Effect.map((result) => ({ handedOverAt: iso(result.handedOverAt) })),
        Effect.catchTag("HandoverRejected", ({ code }) => Effect.succeed(error(status, 404, code))),
      );
    })), { params: t.Object({ id: t.Numeric(), itemId: t.Numeric() }) })
    /** The event is over when whoever is running it says so — never on a timer. */
    .post("/organizer/events/:id/end", ({ params, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      fireEffects((yield* endEvent(params.id, now())).effects);
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? (yield* eventView(updated)) : error(status, 404, "event_not_found");
    })), { params: idParams })
    .post("/organizer/events/:id/reopen", ({ params, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      fireEffects((yield* reopenEvent(params.id, now())).effects);
      // Rosters are only kept in line on live runs, so one coming back is brought up to date.
      yield* syncEventStaff(params.id, now());
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? (yield* eventView(updated)) : error(status, 404, "event_not_found");
    })), { params: idParams })
    .post("/organizer/events/:id/attendance/:userId", ({ params, actor, status }) => run(Effect.gen(function* () {
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      return yield* manualToggleCheckin(params.id, params.userId, now()).pipe(
        Effect.catchTag("CheckinRejected", ({ code }) => Effect.succeed(error(status, 400, code))),
      );
    })), { params: t.Object({ id: t.Numeric(), userId: t.Numeric() }) })
    /** HQ: live runs, what needs a person, and what is next — over the same events as /organizer/events. */
    .get("/organizer/hq", ({ actor }) => run(Effect.gen(function* () {
      return (yield* hqOverview(actor, now()));
    })))
    /** The phase and the numbers of one event's screen, beyond what eventView and the roster carry. */
    .get("/organizer/events/:id/summary", ({ params, actor, status }) => run(Effect.gen(function* () {
      const found = yield* manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const summary = yield* eventSummary(params.id, now());
      // Cancelling is a branch admin's call; the screen needs to know whether to offer it.
      return summary
        ? { ...summary, canCancel: canAdminCity(actor, found.event.city), organizers: (yield* organizersOf(params.id)) }
        : error(status, 404, "event_not_found");
    })), { params: idParams })

    .patch("/admin/events/:id", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const { event } = found;
      // Moving a run between branches means handing it to people you may not be;
      // it takes authority over both ends.
      if (body.city !== undefined && body.city !== event.city && !canAdminCity(actor, body.city)) {
        return error(status, 403, "forbidden");
      }
      const targetCity = body.city ?? event.city;
      const startsAt = body.startsAt === undefined ? undefined : parseDate(body.startsAt);
      if (body.startsAt !== undefined && !startsAt) return error(status, 400, "invalid_starts_at");
      const locationUrl = body.locationUrl === undefined ? undefined : parseLocationUrl(body.locationUrl);
      if (body.locationUrl !== undefined && locationUrl === undefined) return error(status, 400, "invalid_location_url");
      if (body.groups && (yield* unknownGroup(targetCity, body.groups))) return error(status, 400, "unknown_group");
      if ((yield* unknownHomeChat(targetCity, body.homeChatId))) return error(status, 400, "unknown_home_chat");
      const changes: EventChange[] = [
        body.title !== undefined && body.title !== event.title ? "title" : null,
        body.description !== undefined && body.description !== event.description ? "description" : null,
        startsAt !== undefined && startsAt.getTime() !== event.startsAt.getTime() ? "startsAt" : null,
        (body.location !== undefined && body.location !== event.location) || (locationUrl !== undefined && locationUrl !== event.locationUrl) ? "location" : null,
        body.capacity !== undefined && body.capacity !== event.capacity ? "capacity" : null,
      ].filter((change): change is EventChange => change !== null);
      if (body.groups !== undefined) yield* setEventChats(params.id, body.groups);
      if (body.title !== undefined || body.description !== undefined || startsAt !== undefined || body.location !== undefined || locationUrl !== undefined || body.status !== undefined || body.waitlistEnabled !== undefined || body.remindersEnabled !== undefined || body.homeChatId !== undefined || body.city !== undefined) db.update(events).set({
        ...(body.city === undefined ? {} : { city: body.city }),
        ...(body.title === undefined ? {} : { title: body.title }), ...(body.description === undefined ? {} : { description: body.description }), ...(startsAt === undefined ? {} : { startsAt }), ...(body.location === undefined ? {} : { location: body.location }), ...(locationUrl === undefined ? {} : { locationUrl }), ...(body.status === undefined ? {} : { status: body.status }), ...(body.waitlistEnabled === undefined ? {} : { waitlistEnabled: body.waitlistEnabled }), ...(body.remindersEnabled === undefined ? {} : { remindersEnabled: body.remindersEnabled }), ...(body.homeChatId === undefined ? {} : { homeChatId: body.homeChatId }), updatedAt: now(),
      }).where(eq(events.id, params.id)).run();
      if (body.capacity !== undefined) fireEffects((yield* setCapacity(params.id, body.capacity, now())));
      // Switching the queue back on hands out the spots the dormant queue missed.
      if (body.waitlistEnabled === true && !event.waitlistEnabled) fireEffects((yield* issueOffers(params.id, now())));
      if (body.status !== undefined && body.status !== "canceled" && event.status === "canceled") yield* syncEventStaff(params.id, now());
      if (body.status === "canceled" && event.status !== "canceled") {
        const result = yield* cancelEvent(params.id);
        fireEffects(result.effects);
        background(notifyEventCanceled(result.userIds, params.id));
        if (paymentProvider) {
          void runAsync(refundCanceledEvent(params.id, now()).pipe(Effect.provideService(Payments, paymentProvider)))
            .then(fireEffects)
            .catch((cause) => console.error(`Automatic refunds failed for event ${params.id}`, cause));
        }
      }
      if (event.status !== "draft" && body.status !== "canceled" && changes.length) background(notifyEventUpdated((yield* activeParticipantIds(params.id)), params.id, changes));
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? (yield* eventView(updated)) : error(status, 404, "event_not_found");
    })), { params: idParams, body: eventPatchBody })
    .delete("/admin/events/:id", ({ params, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const hasOrders = db.select({ id: ticketOrders.id }).from(ticketOrders).where(eq(ticketOrders.eventId, params.id)).get();
      if (hasOrders) return error(status, 409, "event_has_payment_history");
      db.delete(events).where(eq(events.id, params.id)).run();
      return { ok: true };
    })), { params: idParams })
    .post("/admin/events/:id/series", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      return yield* attachEvent(params.id, body.seriesId).pipe(
        Effect.flatMap(Effect.fnUntraced(function* () {
          const event = db.select().from(events).where(eq(events.id, params.id)).get();
          return event ? yield* eventView(event) : error(status, 404, "event_not_found");
        })),
        Effect.catchTag("SeriesRejected", ({ code }) => Effect.succeed(
          error(status, code === "event_not_found" || code === "series_not_found" ? 404 : 409, code),
        )),
      );
    })), { params: idParams, body: t.Object({ seriesId: t.Integer({ minimum: 1 }) }) })
    .delete("/admin/events/:id/series", ({ params, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      return yield* detachEvent(params.id).pipe(
        Effect.flatMap(Effect.fnUntraced(function* () {
          const event = db.select().from(events).where(eq(events.id, params.id)).get();
          return event ? yield* eventView(event) : error(status, 404, "event_not_found");
        })),
        Effect.catchTag("SeriesRejected", ({ code }) => Effect.succeed(error(status, 404, code))),
      );
    })), { params: idParams })
    .put("/admin/events/:id/organizers", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      db.$client.transaction(() => {
        db.delete(eventOrganizers).where(eq(eventOrganizers.eventId, params.id)).run();
        for (const userId of [...new Set(body.userIds)]) db.insert(eventOrganizers).values({ eventId: params.id, userId }).run();
      })();
      yield* syncEventStaff(params.id, now());
      return { userIds: [...new Set(body.userIds)] };
    })), { params: idParams, body: t.Object({ userIds: t.Array(t.Integer()) }) })
    .get("/admin/events/:id/stats", ({ params, actor, status }) => run(Effect.gen(function* () {
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const stats = yield* eventStats(params.id);
      return {
        ...stats,
        noShowRate: stats.registered ? (stats.registered - stats.checkedIn) / stats.registered : 0,
        waitlistConversion: stats.offersMade ? stats.offersAccepted / stats.offersMade : 0,
      };
    })), { params: idParams })
    .get("/admin/events/:id/orders", ({ params, actor, status }) => run(Effect.gen(function* () {
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      return { orders: (yield* ordersForEvent(params.id)), paymentsConfigured };
    })), { params: idParams })
    .post("/admin/events/:id/orders/:orderId/refund", ({ params, actor, status }) => runAsync(Effect.gen(function* () {
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      if (!paymentProvider) return error(status, 503, "payments_not_configured");
      return yield* requestAdminRefund(params.id, params.orderId, now()).pipe(
        Effect.provideService(Payments, paymentProvider),
        Effect.flatMap(Effect.fnUntraced(function* ({ effects }) {
          fireEffects(effects);
          const order = (yield* ordersForEvent(params.id)).find((entry) => entry.orderId === params.orderId);
          return order ?? error(status, 404, "order_not_found");
        })),
        Effect.catchTag("OrderRejected", ({ code }) => Effect.succeed(error(status, code === "order_not_found" ? 404 : 409, code))),
        Effect.catchDefect((cause) => Effect.gen(function* () {
          console.error(`Admin refund failed for order ${params.orderId}`, cause instanceof Error ? cause.message : "unknown error");
          const order = (yield* ordersForEvent(params.id)).find((entry) => entry.orderId === params.orderId);
          return order?.status === "refund_pending"
            ? order
            : error(status, 503, "payment_temporarily_unavailable");
        })),
      );
    })), { params: t.Object({ id: t.Numeric(), orderId: t.String({ minLength: 1 }) }) })
    .get("/admin/events/:id/link", ({ params, actor, status }) => runAsync(Effect.gen(function* () {
      const found = yield* administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const username = bot.info?.username ?? (yield* Effect.promise(() => bot.api.getMe())).username;
      if (!username) return error(status, 400, "bot_username_unavailable");
      return { miniAppLink: miniAppEventLink(username, "app", params.id), botLink: botEventLink(username, params.id) };
    })), { params: idParams })
    .get("/admin/users", ({ query, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      if (!runsAnyBranch(actor)) return error(status, 403, "forbidden");
      const term = query.query?.trim();
      const predicate = term ? or(sql`${users.firstName} LIKE ${`%${term}%`}`, sql`${users.lastName} LIKE ${`%${term}%`}`, sql`${users.username} LIKE ${`%${term}%`}`, sql`${users.phone} LIKE ${`%${term}%`}`) : undefined;
      return db.select().from(users).where(predicate).orderBy(asc(users.firstName)).all().map((person) => ({
        ...userView(person),
        isConfiguredAdmin: adminIds.has(person.id),
        roles: db.select({ city: userCityRoles.city, role: userCityRoles.role }).from(userCityRoles)
          .where(eq(userCityRoles.userId, person.id)).orderBy(asc(userCityRoles.city)).all(),
        registrationCount: db.select({ value: sql<number>`count(*)` }).from(registrations).where(and(eq(registrations.userId, person.id), ne(registrations.status, "canceled"))).get()?.value ?? 0,
      }));
    })), { query: t.Object({ query: t.Optional(t.String()) }) })
    .post("/admin/users/:id/ban", ({ params, isAdmin, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      db.update(users).set({ isBanned: true }).where(eq(users.id, params.id)).run();
      yield* syncAllStaff(now());
      return { ok: true };
    })), { params: idParams })
    .post("/admin/users/:id/unban", ({ params, isAdmin, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      db.update(users).set({ isBanned: false }).where(eq(users.id, params.id)).run();
      yield* syncAllStaff(now());
      return { ok: true };
    })), { params: idParams })
    /**
     * Appoint or unappoint someone in one branch. A general admin may set anything;
     * a branch admin may only hand out and take back the organizer role in their own
     * branch, so nobody can mint a peer or unseat one.
     */
    .put("/admin/users/:id/roles", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      const current = db.select({ role: userCityRoles.role }).from(userCityRoles)
        .where(and(eq(userCityRoles.city, body.city), eq(userCityRoles.userId, params.id))).get()?.role ?? null;
      if (!canGrantRole(actor, body.city, body.role, current)) return error(status, 403, "forbidden");
      if (body.role === null) {
        db.delete(userCityRoles).where(and(eq(userCityRoles.city, body.city), eq(userCityRoles.userId, params.id))).run();
      } else {
        db.insert(userCityRoles).values({ city: body.city, userId: params.id, role: body.role })
          .onConflictDoUpdate({ target: [userCityRoles.city, userCityRoles.userId], set: { role: body.role } }).run();
      }
      return {
        roles: db.select({ city: userCityRoles.city, role: userCityRoles.role }).from(userCityRoles)
          .where(eq(userCityRoles.userId, params.id)).orderBy(asc(userCityRoles.city)).all(),
      };
    })), { params: idParams, body: t.Object({ city: citySchema, role: t.Nullable(cityRoleSchema) }) })
    /** The chats an event in this branch may be gated to or funnelled into. */
    .get("/admin/groups", ({ query, actor, status }) => runAsync(Effect.gen(function* () {
      if (!canAdminCity(actor, query.city)) return error(status, 403, "forbidden");
      const ids = yield* assignableChats(query.city);
      yield* refreshChatStates(ids);
      return { groups: yield* Effect.forEach(ids, Effect.fnUntraced(function* (id) {
        return { id, ...(yield* chatState(id)) };
      })) };
    })), { query: t.Object({ city: citySchema }) })
    /**
     * The catalog itself. The bot files chats as it meets them; a general admin says
     * which branch each belongs to. Branch admins get a read-only view of their own.
     */
    .get("/admin/chats", ({ actor, status }) => runAsync(Effect.gen(function* () {
      if (!runsAnyBranch(actor)) return error(status, 403, "forbidden");
      const catalog = yield* chatCatalog(adminCities(actor), actor.isGlobalAdmin);
      yield* refreshChatStates(catalog.map((chat) => chat.id));
      return {
        chats: yield* Effect.forEach(catalog, Effect.fnUntraced(function* (chat) {
          return { ...chat, ...(yield* chatState(chat.id)), createdAt: iso(chat.createdAt), checkedAt: iso(chat.checkedAt) };
        })),
        canAssign: actor.isGlobalAdmin,
      };
    })))
    .put("/admin/chats/:id", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      // Filing a chat under a branch is a club-wide act: it decides which admins
      // gain reach into that group.
      if (!actor.isGlobalAdmin) return error(status, 403, "forbidden");
      if (!(yield* chatById(params.id))) return error(status, 404, "chat_not_found");
      yield* setChatCity(params.id, body.city);
      return { ok: true };
    })), { params: idParams, body: t.Object({ city: t.Nullable(citySchema) }) })
    .post("/admin/users/:id/promote", ({ params, isAdmin, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      db.update(users).set({ isAdmin: true }).where(eq(users.id, params.id)).run();
      return { ok: true };
    })), { params: idParams })
    .post("/admin/users/:id/demote", ({ params, isAdmin, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      if (!isAdmin) return error(status, 403, "forbidden");
      if (adminIds.has(params.id)) return error(status, 409, "configured_admin_cannot_be_demoted");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      db.update(users).set({ isAdmin: false }).where(eq(users.id, params.id)).run();
      return { ok: true };
    })), { params: idParams })
    /**
     * HQ's "Needs attention": what is stuck until an admin acts, across the branches
     * they run (or the one they ask for). Branchless chats only reach general admins,
     * the only people who may file them.
     */
    .get("/admin/attention", ({ query, actor, status }) => run(Effect.gen(function* () {
      if (!runsAnyBranch(actor)) return error(status, 403, "forbidden");
      if (query.city !== undefined && !canAdminCity(actor, query.city)) return error(status, 403, "forbidden");
      return yield* needsAttention(query.city === undefined ? adminCities(actor) : [query.city], actor.isGlobalAdmin, now());
    })), { query: t.Object({ city: t.Optional(citySchema) }) })
    /** The person card. Any branch admin may open it; what they may change is in `roles[].grantable`. */
    .get("/admin/users/:id", ({ params, actor, status }) => run(Effect.gen(function* () {
      if (!runsAnyBranch(actor)) return error(status, 403, "forbidden");
      return (yield* personCard(actor, params.id, adminIds)) ?? error(status, 404, "user_not_found");
    })), { params: idParams })
    /**
     * The card's Save: several branches in one go, all or nothing. Unchanged rows may
     * be sent back as they are; only the ones that differ are held to `canGrantRole`.
     */
    .put("/admin/users/:id/city-roles", ({ params, body, actor, status }) => run(Effect.gen(function* () {
      const db = yield* Database;
      // A save with nothing to change still returns the card, so it needs the card's own gate.
      if (!runsAnyBranch(actor)) return error(status, 403, "forbidden");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      return yield* setCityRoles(actor, params.id, body.roles).pipe(
        Effect.flatMap(() => personCard(actor, params.id, adminIds)),
        Effect.map((card) => card ?? error(status, 404, "user_not_found")),
        Effect.catchTag("RolesRejected", ({ code }) => Effect.succeed(error(status, code === "forbidden" ? 403 : 400, code))),
      );
    })), { params: idParams, body: t.Object({ roles: t.Array(t.Object({ city: citySchema, role: t.Nullable(cityRoleSchema) }), { maxItems: cities.length }) }) })
    .get("/admin/stats", ({ query, actor, status }) => run(Effect.gen(function* () {
      if (!runsAnyBranch(actor)) return error(status, 403, "forbidden");
      // A general admin sees the whole club unless they ask for one branch; a branch
      // admin only ever sees theirs, and sees it without having to ask.
      const runs = adminCities(actor);
      const city = query.city ?? (actor.isGlobalAdmin ? null : runs[0] ?? null);
      if (city !== null && !canAdminCity(actor, city)) return error(status, 403, "forbidden");
      return { ...(yield* globalStats(city)), month: (yield* monthStats(city, now())) };
    })), { query: t.Object({ city: t.Optional(citySchema) }) }))
  .get("/*", ({ request }) => staticFile(new URL(request.url).pathname));

export type App = typeof app;
