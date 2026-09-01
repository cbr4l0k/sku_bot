import { Elysia, t } from "elysia";

import { cities, cityRoles, type CitySlug } from "@sku/cities";
import {
  and,
  asc,
  chats,
  desc,
  eq,
  eventProducts,
  eventOrganizers,
  events,
  inArray,
  isNull,
  ne,
  or,
  registrations,
  sql,
  ticketOrders,
  ticketTiers,
  userCityRoles,
  users,
  waitlistOffers,
} from "@sku/db";
import { bot } from "../bot";
import type { EventChange } from "../bot/event-card";
import { checkIn, isEventOver, manualToggleCheckin, mintCheckinToken, verifyCheckinToken } from "../core/checkin";
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
  createCheckout,
  orderForUser,
  reconcilePayment,
  reconcileRefund,
  refundCanceledEvent,
  requestUserRefund,
} from "../core/tickets";
import { eventStats, globalStats } from "../core/stats";
import { acceptOffer, cancelEvent, endEvent, issueOffers, reopenEvent, setCapacity } from "../core/waitlist";
import { db } from "../db";
import { loadEnv } from "../env";
import { paymentProvider, paymentsConfigured } from "../payments";
import { dispatchEffects, notifyEventCanceled, notifyEventUpdated } from "../notify";
import { auth } from "./auth";

const env = loadEnv();
const adminIds = new Set(env.ADMIN_IDS);
const miniappDist = new URL("../../../miniapp/dist/", import.meta.url);
const now = () => new Date();
const iso = (value: Date | null) => value?.toISOString() ?? null;
const fireEffects = (effects: Parameters<typeof dispatchEffects>[0]) => {
  void dispatchEffects(effects).catch(console.error);
};
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

const ticketTierView = (tier: typeof ticketTiers.$inferSelect) => ({
  ...tier,
  salesStartAt: iso(tier.salesStartAt),
  salesEndAt: iso(tier.salesEndAt),
  createdAt: tier.createdAt.toISOString(),
  updatedAt: tier.updatedAt.toISOString(),
  claimed: db.select({ value: sql<number>`count(*)` }).from(ticketOrders)
    .where(and(eq(ticketOrders.ticketTierId, tier.id), inArray(ticketOrders.status, ["awaiting_payment", "payment_succeeded", "fulfilled", "refund_pending", "refund_failed"]))).get()?.value ?? 0,
});

const eventProductView = (product: typeof eventProducts.$inferSelect) => ({
  ...product,
  createdAt: product.createdAt.toISOString(),
  updatedAt: product.updatedAt.toISOString(),
  claimed: db.$client.query<{ value: number | null }, [number]>(`
    SELECT sum(i.quantity) AS value FROM order_items i
    JOIN ticket_orders o ON o.id = i.order_id
    WHERE i.event_product_id = ?
      AND o.status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
  `).get(product.id)?.value ?? 0,
});

const eventView = (event: typeof events.$inferSelect) => ({
  ...event,
  groups: chatsOfEvent(db, event.id).map((id) => ({ id, title: chatTitle(id) ?? String(id) })),
  homeChat: event.homeChatId === null ? null : { id: event.homeChatId, title: chatTitle(event.homeChatId) ?? String(event.homeChatId) },
  startsAt: event.startsAt.toISOString(),
  endedAt: iso(event.endedAt),
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString(),
  ticketTiers: db.select().from(ticketTiers).where(eq(ticketTiers.eventId, event.id))
    .orderBy(asc(ticketTiers.sortOrder), asc(ticketTiers.id)).all().map(ticketTierView),
  products: db.select().from(eventProducts).where(eq(eventProducts.eventId, event.id))
    .orderBy(asc(eventProducts.sortOrder), asc(eventProducts.id)).all().map(eventProductView),
  paymentsConfigured,
  pendingTicketCount: db.select({ value: sql<number>`count(*)` }).from(ticketOrders)
    .where(and(eq(ticketOrders.eventId, event.id), inArray(ticketOrders.status, ["awaiting_payment", "payment_succeeded"]))).get()?.value ?? 0,
});

/**
 * A chat belongs to exactly one branch, so an event may only reach chats of its
 * own. This is what keeps a Kazan admin out of Moscow's groups. Stored rows
 * outlive the catalog, so an event keeps whatever it was given before a chat moved.
 */
const unknownGroup = (city: CitySlug, groups: readonly number[]) => {
  const allowed = new Set(assignableChats(db, city));
  return groups.some((id) => !allowed.has(id));
};
/** Guests can only be funnelled into a chat of the event's own branch. */
const unknownHomeChat = (city: CitySlug, chatId: number | null | undefined) =>
  chatId !== null && chatId !== undefined && !assignableChats(db, city).includes(chatId);

/** Telegram owns membership, so refresh what the caller is about to be filtered against. */
const syncMemberships = (userId: number, chatIds: readonly number[]) =>
  refreshMemberships(db, telegramMembership, userId, chatIds, now());

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
const manageable = (actor: Actor, eventId: number) => {
  const event = db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return { denied: "event_not_found" as const, code: 404 as const };
  if (!canManageEvent(db, actor, event)) return { denied: "forbidden" as const, code: 403 as const };
  return { event };
};

/** Runs at least one branch, and so has someone to appoint and something to count. */
const runsAnyBranch = (actor: Actor) => actor.isGlobalAdmin || adminCities(actor).length > 0;

/** The same, for the powers reserved to whoever runs the branch. */
const administrable = (actor: Actor, eventId: number) => {
  const event = db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return { denied: "event_not_found" as const, code: 404 as const };
  if (!canAdminCity(actor, event.city)) return { denied: "forbidden" as const, code: 403 as const };
  return { event };
};

const participantEvent = (eventId: number) => db.select().from(events)
  .where(and(eq(events.id, eventId), eq(events.status, "published"))).get();

const activeParticipantIds = (eventId: number) => db.select({ userId: registrations.userId })
  .from(registrations)
  .where(and(eq(registrations.eventId, eventId), inArray(registrations.status, ["registered", "checked_in", "waitlisted"])))
  .all()
  .map((row) => row.userId);

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
});

const eventPatchFields = t.Partial(eventFields);
const eventStatus = t.Union([t.Literal("draft"), t.Literal("published"), t.Literal("closed"), t.Literal("canceled")]);
const idParams = t.Object({ id: t.Numeric() });
const ticketTierBody = t.Object({
  id: t.Optional(t.Integer({ minimum: 1 })),
  name: t.String({ minLength: 1, maxLength: 80 }),
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
  .post("/api/payments/yookassa/webhook", async ({ body, query, status }) => {
    if (!paymentProvider) return error(status, 503, "payments_not_configured");
    if (!env.YOOKASSA_WEBHOOK_SECRET || query.secret !== env.YOOKASSA_WEBHOOK_SECRET) return error(status, 403, "invalid_webhook_secret");
    if (!body || typeof body !== "object" || !("event" in body) || !("object" in body)) return error(status, 400, "invalid_webhook");
    const event = (body as { event?: unknown }).event;
    const object = (body as { object?: unknown }).object;
    if (typeof event !== "string" || !object || typeof object !== "object" || !("id" in object) || typeof object.id !== "string") {
      return error(status, 400, "invalid_webhook");
    }
    if (event.startsWith("payment.")) {
      fireEffects((await reconcilePayment(db, paymentProvider, object.id, now())).effects);
    } else if (event.startsWith("refund.")) {
      fireEffects(await reconcileRefund(db, paymentProvider, object.id, now()));
    }
    return { ok: true };
  }, { body: t.Any(), query: t.Object({ secret: t.String({ minLength: 20 }) }) })
  .group("/api", (api) => api
    .use(auth)
    .get("/me", ({ user, actor }) => {
      const isOrganizerOfAny = Boolean(db.select({ eventId: eventOrganizers.eventId }).from(eventOrganizers)
        .where(eq(eventOrganizers.userId, user.id)).get());
      return {
        ...userView(user),
        isOrganizerOfAny,
        roles: [...actor.roles].map(([city, role]) => ({ city, role })),
        adminCities: adminCities(actor),
        organizerCities: organizerCities(actor),
      };
    })
    .patch("/me", ({ user, body }) => {
      db.update(users).set({
        ...(body.locale === undefined ? {} : { locale: body.locale }),
        ...(body.city === undefined ? {} : { city: body.city }),
        ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
        ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
      }).where(eq(users.id, user.id)).run();
      const updated = db.select().from(users).where(eq(users.id, user.id)).get();
      return updated ? userView(updated) : userView(user);
    }, { body: t.Object({ locale: t.Optional(t.Union([t.Literal("ru"), t.Literal("en")])), city: t.Optional(citySchema), firstName: t.Optional(t.String()), lastName: t.Optional(t.String()) }) })
    .get("/events", async ({ user }) => {
      // Nothing to show until they have said which branch is theirs; the mini app
      // puts the picker up in place of the list rather than guessing.
      if (user.city === null) return [];
      await syncMemberships(user.id, chatsGatingLiveEvents(db));
      // A started event stays listed until an organizer ends it, so people can still
      // find it to sign up late or to check in on their way out.
      return db.select().from(events)
        .where(and(eq(events.status, "published"), isNull(events.endedAt), visibleToUser(user.id), inCityForUser(user.city, user.id)))
        .orderBy(asc(events.startsAt)).all().map((event) => {
          const registration = db.select({ status: registrations.status }).from(registrations)
            .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, user.id))).get();
          const offer = db.select({ id: waitlistOffers.id, expiresAt: waitlistOffers.expiresAt }).from(waitlistOffers)
            .where(and(eq(waitlistOffers.eventId, event.id), eq(waitlistOffers.userId, user.id), eq(waitlistOffers.status, "pending")))
            .orderBy(desc(waitlistOffers.offeredAt)).get();
          const confirmedCount = db.select({ value: sql<number>`count(*)` }).from(registrations)
            .where(and(eq(registrations.eventId, event.id), inArray(registrations.status, ["registered", "checked_in"]))).get()?.value ?? 0;
          const waitlistSize = db.select({ value: sql<number>`count(*)` }).from(registrations)
            .where(and(eq(registrations.eventId, event.id), eq(registrations.status, "waitlisted"))).get()?.value ?? 0;
          return { ...eventView(event), myRegistrationStatus: registration?.status ?? null, myPendingOffer: offer ? { id: offer.id, expiresAt: offer.expiresAt.toISOString() } : null, confirmedCount, waitlistSize };
        });
    })
    .get("/events/:id", async ({ params, user, status }) => {
      const event = participantEvent(params.id);
      if (!event) return error(status, 404, "event_not_found");
      await syncMemberships(user.id, chatsOfEvent(db, event.id));
      // A restricted event stays invisible rather than forbidden — do not leak that it exists.
      if (!canSeeEvent(db, event.id, user.id)) return error(status, 404, "event_not_found");
      const registration = db.select({ status: registrations.status }).from(registrations)
        .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, user.id))).get();
      const waitlisted = registration?.status === "waitlisted";
      const waitlistPosition = waitlisted ? db.select({ userId: registrations.userId }).from(registrations)
        .where(and(eq(registrations.eventId, event.id), eq(registrations.status, "waitlisted"))).orderBy(asc(registrations.createdAt), asc(registrations.id)).all()
        .findIndex((row) => row.userId === user.id) + 1 : null;
      return { ...eventView(event), myRegistrationStatus: registration?.status ?? null, myWaitlistPosition: waitlistPosition };
    }, { params: idParams })
    .post("/events/:id/join", async ({ params, user, status }) => {
      if (user.isBanned) return error(status, 403, "banned");
      const paid = db.select({ id: ticketTiers.id }).from(ticketTiers).where(eq(ticketTiers.eventId, params.id)).get();
      if (paid) return error(status, 409, "payment_required");
      await syncMemberships(user.id, chatsOfEvent(db, params.id));
      const result = joinEvent(db, params.id, user.id, now());
      if ("error" in result) {
        const code = result.error === "already_joined" || result.error === "event_full" ? 409 : result.error === "not_eligible" ? 403 : 400;
        return error(status, code, result.error);
      }
      return result;
    }, { params: idParams })
    .post("/events/:id/checkout", async ({ params, body, user, status }) => {
      if (user.isBanned) return error(status, 403, "banned");
      if (!paymentProvider) return error(status, 503, "payments_not_configured");
      await syncMemberships(user.id, chatsOfEvent(db, params.id));
      let result: Awaited<ReturnType<typeof createCheckout>>;
      try {
        result = await createCheckout(db, paymentProvider, {
          eventId: params.id,
          tierId: body.ticketTierId,
          productItems: body.items,
          userId: user.id,
          userPhone: user.phone,
          returnUrl: `https://${env.DOMAIN}/events/${params.id}`,
        }, now());
      } catch (cause) {
        console.error("YooKassa checkout creation failed", cause instanceof Error ? cause.message : "unknown error");
        return error(status, 503, "payment_temporarily_unavailable");
      }
      if ("error" in result) {
        const code = result.error === "not_eligible" ? 403
          : ["already_joined", "ticket_sold_out", "product_sold_out", "event_full", "active_order_exists"].includes(result.error) ? 409
            : result.error === "event_not_found" ? 404 : 400;
        return error(status, code, result.error);
      }
      return result;
    }, {
      params: idParams,
      body: t.Object({
        ticketTierId: t.Integer({ minimum: 1 }),
        items: t.Optional(t.Array(t.Object({
          productId: t.Integer({ minimum: 1 }),
          quantity: t.Integer({ minimum: 1, maximum: 20 }),
        }), { maxItems: 20 })),
      }),
    })
    .get("/orders/:id", ({ params, user, status }) => {
      const order = orderForUser(db, params.id, user.id);
      return order ?? error(status, 404, "order_not_found");
    }, { params: t.Object({ id: t.String({ minLength: 1 }) }) })
    .post("/events/:id/cancel", async ({ params, user, status }) => {
      if (user.isBanned) return error(status, 403, "banned");
      if (!participantEvent(params.id)) return error(status, 404, "event_not_found");
      const paidOrder = db.select({ id: ticketOrders.id }).from(ticketOrders)
        .where(and(eq(ticketOrders.eventId, params.id), eq(ticketOrders.userId, user.id), inArray(ticketOrders.status, ["fulfilled", "refund_pending", "refund_failed"]))).get();
      if (paidOrder) {
        if (!paymentProvider) return error(status, 503, "payments_not_configured");
        try {
          fireEffects(await requestUserRefund(db, paymentProvider, params.id, user.id, now()) ?? []);
          return { ok: true, refundPending: true };
        } catch (cause) {
          console.error(`YooKassa refund creation failed for order ${paidOrder.id}`, cause instanceof Error ? cause.message : "unknown error");
          const pending = db.select({ status: ticketOrders.status }).from(ticketOrders).where(eq(ticketOrders.id, paidOrder.id)).get();
          return pending?.status === "refund_pending"
            ? { ok: true, refundPending: true }
            : error(status, 503, "payment_temporarily_unavailable");
        }
      }
      const result = cancelRegistration(db, params.id, user.id, now());
      fireEffects(result.effects);
      return { ok: true, refundPending: false };
    }, { params: idParams })
    .post("/offers/:id/accept", ({ params, user, status }) => {
      if (user.isBanned) return error(status, 403, "banned");
      const result = acceptOffer(db, params.id, user.id, now());
      if (!result.ok) return error(status, 409, result.reason);
      fireEffects(result.effects);
      return { ok: true };
    }, { params: idParams })
    .post("/checkin", ({ body, user, status }) => {
      if (user.isBanned) return error(status, 403, "banned");
      const token = verifyCheckinToken(env.CHECKIN_SECRET, body.code, now());
      if (!token) return error(status, 400, "invalid_or_stale_code");
      const result = checkIn(db, token.eventId, user.id, now());
      if ("error" in result) return error(status, 400, result.error);
      return result;
    }, { body: t.Object({ code: t.String({ minLength: 1 }) }) })

    .get("/organizer/events", ({ user, isAdmin, actor }) => {
      if (isAdmin) return db.select().from(events).orderBy(desc(events.startsAt)).all().map(eventView);
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
      return [...merged.values()].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()).map(eventView);
    })
    /**
     * Raising an event is an organizer's job, not an admin's — a branch organizer
     * exists precisely so someone can put a run on without the club's keys. The
     * fields that reach beyond the event itself stay admin-only, as they were.
     */
    .post("/organizer/events", ({ body, user, actor, status }) => {
      if (!canCreateEventIn(actor, body.city)) return error(status, 403, "forbidden");
      const startsAt = parseDate(body.startsAt);
      if (!startsAt) return error(status, 400, "invalid_starts_at");
      const locationUrl = body.locationUrl === undefined ? null : parseLocationUrl(body.locationUrl);
      if (locationUrl === undefined) return error(status, 400, "invalid_location_url");
      const asAdmin = canAdminCity(actor, body.city);
      if (!asAdmin && (body.groups?.length || body.homeChatId != null || body.status !== undefined)) {
        return error(status, 403, "forbidden");
      }
      if (body.groups && unknownGroup(body.city, body.groups)) return error(status, 400, "unknown_group");
      if (unknownHomeChat(body.city, body.homeChatId)) return error(status, 400, "unknown_home_chat");
      const { groups, ...fields } = body;
      const created = db.$client.transaction(() => {
        const row = db.insert(events).values({ ...fields, locationUrl, startsAt, createdBy: user.id, status: body.status ?? "draft" }).returning().get();
        // Whoever raised it runs it, or they could not reopen the form they just left.
        db.insert(eventOrganizers).values({ eventId: row.id, userId: user.id }).onConflictDoNothing().run();
        return row;
      })();
      if (groups) setEventChats(db, created.id, groups);
      return eventView(created);
    }, { body: eventCreateBody })
    .patch("/organizer/events/:id", ({ params, body, actor, status }) => {
      const found = manageable(actor, params.id);
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
      if (body.title !== undefined || body.description !== undefined || startsAt !== undefined || body.location !== undefined || locationUrl !== undefined || body.waitlistEnabled !== undefined) {
        db.update(events).set({
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(startsAt === undefined ? {} : { startsAt }),
          ...(body.location === undefined ? {} : { location: body.location }),
          ...(locationUrl === undefined ? {} : { locationUrl }),
          ...(body.waitlistEnabled === undefined ? {} : { waitlistEnabled: body.waitlistEnabled }),
          updatedAt: now(),
        }).where(eq(events.id, params.id)).run();
      }
      if (body.capacity !== undefined) fireEffects(setCapacity(db, params.id, body.capacity, now()));
      // Switching the queue back on hands out the spots the dormant queue missed.
      if (body.waitlistEnabled === true && !event.waitlistEnabled) fireEffects(issueOffers(db, params.id, now()));
      if (event.status !== "draft" && changes.length) void notifyEventUpdated(activeParticipantIds(params.id), params.id, changes).catch(console.error);
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? eventView(updated) : error(status, 404, "event_not_found");
    }, { params: idParams, body: eventPatchFields })
    .put("/organizer/events/:id/ticket-tiers", ({ params, body, actor, status }) => {
      const found = manageable(actor, params.id);
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
        parsed.forEach((tier, sortOrder) => {
          const values = {
            name: tier.name,
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
      return event ? eventView(event) : error(status, 404, "event_not_found");
    }, { params: idParams, body: t.Object({ tiers: t.Array(ticketTierBody, { maxItems: 20 }) }) })
    .put("/organizer/events/:id/products", ({ params, body, actor, status }) => {
      const found = manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const parsed = body.products.map((product) => ({
        ...product,
        name: product.name.trim(),
        description: product.description?.trim() || null,
      }));
      if (parsed.some((product) => !product.name)) return error(status, 400, "invalid_product");
      const ids = parsed.flatMap((product) => product.id === undefined ? [] : [product.id]);
      if (new Set(ids).size !== ids.length) return error(status, 400, "duplicate_product");
      if (ids.length) {
        const owned = db.select({ id: eventProducts.id }).from(eventProducts)
          .where(and(eq(eventProducts.eventId, params.id), inArray(eventProducts.id, ids))).all();
        if (owned.length !== ids.length) return error(status, 400, "product_not_found");
      }
      for (const product of parsed) {
        if (product.id === undefined || product.stock === null) continue;
        const claimed = db.$client.query<{ value: number | null }, [number]>(`
          SELECT sum(i.quantity) AS value FROM order_items i
          JOIN ticket_orders o ON o.id = i.order_id
          WHERE i.event_product_id = ?
            AND o.status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
        `).get(product.id)?.value ?? 0;
        if (product.stock < claimed) return error(status, 409, "product_stock_below_claimed");
      }
      db.$client.transaction(() => {
        db.update(eventProducts).set({ active: false, updatedAt: now() }).where(eq(eventProducts.eventId, params.id)).run();
        parsed.forEach((product, sortOrder) => {
          const values = {
            kind: product.kind,
            name: product.name,
            description: product.description,
            priceMinor: product.priceMinor,
            stock: product.stock,
            maxPerOrder: product.maxPerOrder,
            active: product.active ?? true,
            sortOrder,
            updatedAt: now(),
          };
          if (product.id === undefined) db.insert(eventProducts).values({ eventId: params.id, ...values }).run();
          else db.update(eventProducts).set(values).where(eq(eventProducts.id, product.id)).run();
        });
      })();
      const event = db.select().from(events).where(eq(events.id, params.id)).get();
      return event ? eventView(event) : error(status, 404, "event_not_found");
    }, { params: idParams, body: t.Object({ products: t.Array(eventProductBody, { maxItems: 40 }) }) })
    .get("/organizer/events/:id/attendance", ({ params, actor, status }) => {
      const found = manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const attendance = db.select({
        userId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        username: users.username,
        phone: users.phone,
        status: registrations.status,
        checkedInAt: registrations.checkedInAt,
        ticketName: sql<string | null>`(
          SELECT o.ticket_name FROM ticket_orders o
          WHERE o.event_id = ${params.id} AND o.user_id = ${users.id}
          ORDER BY o.created_at DESC LIMIT 1
        )`,
        paymentStatus: sql<string | null>`(
          SELECT o.status FROM ticket_orders o
          WHERE o.event_id = ${params.id} AND o.user_id = ${users.id}
          ORDER BY o.created_at DESC LIMIT 1
        )`,
      })
        .from(registrations).innerJoin(users, eq(registrations.userId, users.id)).where(eq(registrations.eventId, params.id)).orderBy(asc(registrations.createdAt)).all()
        .map((row) => ({
          ...row,
          checkedInAt: iso(row.checkedInAt),
          purchaseItems: db.$client.query<{ name: string; quantity: number; kind: "merchandise" | "addon" }, [number, number]>(`
            SELECT i.name, i.quantity, i.kind FROM order_items i
            JOIN ticket_orders o ON o.id = i.order_id
            WHERE o.event_id = ? AND o.user_id = ? AND i.kind != 'ticket'
              AND o.id = (
                SELECT latest.id FROM ticket_orders latest
                WHERE latest.event_id = o.event_id AND latest.user_id = o.user_id
                ORDER BY latest.created_at DESC LIMIT 1
              )
            ORDER BY i.id
          `).all(params.id, row.userId),
        }));
      return { registrations: attendance, counts: eventStats(db, params.id) };
    }, { params: idParams })
    .get("/organizer/events/:id/checkin-token", ({ params, actor, status }) => {
      const found = manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      // No point showing a code nobody's scan would be accepted from.
      if (isEventOver(db, params.id)) return error(status, 409, "event_over");
      return { token: mintCheckinToken(env.CHECKIN_SECRET, params.id, now()), expiresInSeconds: 45 };
    }, { params: idParams })
    /** The event is over when whoever is running it says so — never on a timer. */
    .post("/organizer/events/:id/end", ({ params, actor, status }) => {
      const found = manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      fireEffects(endEvent(db, params.id, now()).effects);
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? eventView(updated) : error(status, 404, "event_not_found");
    }, { params: idParams })
    .post("/organizer/events/:id/reopen", ({ params, actor, status }) => {
      const found = manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      fireEffects(reopenEvent(db, params.id, now()).effects);
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? eventView(updated) : error(status, 404, "event_not_found");
    }, { params: idParams })
    .post("/organizer/events/:id/attendance/:userId", ({ params, actor, status }) => {
      const found = manageable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const result = manualToggleCheckin(db, params.id, params.userId, now());
      return "error" in result ? error(status, 400, result.error) : result;
    }, { params: t.Object({ id: t.Numeric(), userId: t.Numeric() }) })

    .patch("/admin/events/:id", ({ params, body, actor, status }) => {
      const found = administrable(actor, params.id);
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
      if (body.groups && unknownGroup(targetCity, body.groups)) return error(status, 400, "unknown_group");
      if (unknownHomeChat(targetCity, body.homeChatId)) return error(status, 400, "unknown_home_chat");
      const changes: EventChange[] = [
        body.title !== undefined && body.title !== event.title ? "title" : null,
        body.description !== undefined && body.description !== event.description ? "description" : null,
        startsAt !== undefined && startsAt.getTime() !== event.startsAt.getTime() ? "startsAt" : null,
        (body.location !== undefined && body.location !== event.location) || (locationUrl !== undefined && locationUrl !== event.locationUrl) ? "location" : null,
        body.capacity !== undefined && body.capacity !== event.capacity ? "capacity" : null,
      ].filter((change): change is EventChange => change !== null);
      if (body.groups !== undefined) setEventChats(db, params.id, body.groups);
      if (body.title !== undefined || body.description !== undefined || startsAt !== undefined || body.location !== undefined || locationUrl !== undefined || body.status !== undefined || body.waitlistEnabled !== undefined || body.homeChatId !== undefined || body.city !== undefined) db.update(events).set({
        ...(body.city === undefined ? {} : { city: body.city }),
        ...(body.title === undefined ? {} : { title: body.title }), ...(body.description === undefined ? {} : { description: body.description }), ...(startsAt === undefined ? {} : { startsAt }), ...(body.location === undefined ? {} : { location: body.location }), ...(locationUrl === undefined ? {} : { locationUrl }), ...(body.status === undefined ? {} : { status: body.status }), ...(body.waitlistEnabled === undefined ? {} : { waitlistEnabled: body.waitlistEnabled }), ...(body.homeChatId === undefined ? {} : { homeChatId: body.homeChatId }), updatedAt: now(),
      }).where(eq(events.id, params.id)).run();
      if (body.capacity !== undefined) fireEffects(setCapacity(db, params.id, body.capacity, now()));
      // Switching the queue back on hands out the spots the dormant queue missed.
      if (body.waitlistEnabled === true && !event.waitlistEnabled) fireEffects(issueOffers(db, params.id, now()));
      if (body.status === "canceled" && event.status !== "canceled") {
        const result = cancelEvent(db, params.id);
        fireEffects(result.effects);
        void notifyEventCanceled(result.userIds, params.id).catch(console.error);
        if (paymentProvider) {
          void refundCanceledEvent(db, paymentProvider, params.id, now())
            .then(fireEffects)
            .catch((cause) => console.error(`Automatic refunds failed for event ${params.id}`, cause));
        }
      }
      if (event.status !== "draft" && body.status !== "canceled" && changes.length) void notifyEventUpdated(activeParticipantIds(params.id), params.id, changes).catch(console.error);
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? eventView(updated) : error(status, 404, "event_not_found");
    }, { params: idParams, body: eventPatchBody })
    .delete("/admin/events/:id", ({ params, actor, status }) => {
      const found = administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const hasOrders = db.select({ id: ticketOrders.id }).from(ticketOrders).where(eq(ticketOrders.eventId, params.id)).get();
      if (hasOrders) return error(status, 409, "event_has_payment_history");
      db.delete(events).where(eq(events.id, params.id)).run();
      return { ok: true };
    }, { params: idParams })
    .put("/admin/events/:id/organizers", ({ params, body, actor, status }) => {
      const found = administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      db.$client.transaction(() => {
        db.delete(eventOrganizers).where(eq(eventOrganizers.eventId, params.id)).run();
        for (const userId of [...new Set(body.userIds)]) db.insert(eventOrganizers).values({ eventId: params.id, userId }).run();
      })();
      return { userIds: [...new Set(body.userIds)] };
    }, { params: idParams, body: t.Object({ userIds: t.Array(t.Integer()) }) })
    .get("/admin/events/:id/stats", ({ params, actor, status }) => {
      const found = administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const stats = eventStats(db, params.id);
      return {
        ...stats,
        noShowRate: stats.registered ? (stats.registered - stats.checkedIn) / stats.registered : 0,
        waitlistConversion: stats.offersMade ? stats.offersAccepted / stats.offersMade : 0,
      };
    }, { params: idParams })
    .get("/admin/events/:id/link", async ({ params, actor, status }) => {
      const found = administrable(actor, params.id);
      if (found.denied) return error(status, found.code, found.denied);
      const username = bot.info?.username ?? (await bot.api.getMe()).username;
      if (!username) return error(status, 400, "bot_username_unavailable");
      return { miniAppLink: miniAppEventLink(username, "app", params.id), botLink: botEventLink(username, params.id) };
    }, { params: idParams })
    .get("/admin/users", ({ query, actor, status }) => {
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
    }, { query: t.Object({ query: t.Optional(t.String()) }) })
    .post("/admin/users/:id/ban", ({ params, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      db.update(users).set({ isBanned: true }).where(eq(users.id, params.id)).run(); return { ok: true };
    }, { params: idParams })
    .post("/admin/users/:id/unban", ({ params, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      db.update(users).set({ isBanned: false }).where(eq(users.id, params.id)).run(); return { ok: true };
    }, { params: idParams })
    /**
     * Appoint or unappoint someone in one branch. A general admin may set anything;
     * a branch admin may only hand out and take back the organizer role in their own
     * branch, so nobody can mint a peer or unseat one.
     */
    .put("/admin/users/:id/roles", ({ params, body, actor, status }) => {
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
    }, { params: idParams, body: t.Object({ city: citySchema, role: t.Nullable(cityRoleSchema) }) })
    /** The chats an event in this branch may be gated to or funnelled into. */
    .get("/admin/groups", async ({ query, actor, status }) => {
      if (!canAdminCity(actor, query.city)) return error(status, 403, "forbidden");
      const ids = assignableChats(db, query.city);
      await refreshChatStates(ids);
      return { groups: ids.map((id) => ({ id, ...chatState(id) })) };
    }, { query: t.Object({ city: citySchema }) })
    /**
     * The catalog itself. The bot files chats as it meets them; a general admin says
     * which branch each belongs to. Branch admins get a read-only view of their own.
     */
    .get("/admin/chats", async ({ actor, status }) => {
      if (!runsAnyBranch(actor)) return error(status, 403, "forbidden");
      const catalog = chatCatalog(db, adminCities(actor), actor.isGlobalAdmin);
      await refreshChatStates(catalog.map((chat) => chat.id));
      return {
        chats: catalog.map((chat) => ({ ...chat, ...chatState(chat.id), createdAt: iso(chat.createdAt), checkedAt: iso(chat.checkedAt) })),
        canAssign: actor.isGlobalAdmin,
      };
    })
    .put("/admin/chats/:id", ({ params, body, actor, status }) => {
      // Filing a chat under a branch is a club-wide act: it decides which admins
      // gain reach into that group.
      if (!actor.isGlobalAdmin) return error(status, 403, "forbidden");
      if (!chatById(db, params.id)) return error(status, 404, "chat_not_found");
      setChatCity(db, params.id, body.city);
      return { ok: true };
    }, { params: idParams, body: t.Object({ city: t.Nullable(citySchema) }) })
    .post("/admin/users/:id/promote", ({ params, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      db.update(users).set({ isAdmin: true }).where(eq(users.id, params.id)).run(); return { ok: true };
    }, { params: idParams })
    .post("/admin/users/:id/demote", ({ params, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      if (adminIds.has(params.id)) return error(status, 409, "configured_admin_cannot_be_demoted");
      if (!db.select({ id: users.id }).from(users).where(eq(users.id, params.id)).get()) return error(status, 404, "user_not_found");
      db.update(users).set({ isAdmin: false }).where(eq(users.id, params.id)).run(); return { ok: true };
    }, { params: idParams })
    .get("/admin/stats", ({ query, actor, status }) => {
      if (!runsAnyBranch(actor)) return error(status, 403, "forbidden");
      // A general admin sees the whole club unless they ask for one branch; a branch
      // admin only ever sees theirs, and sees it without having to ask.
      const runs = adminCities(actor);
      const city = query.city ?? (actor.isGlobalAdmin ? null : runs[0] ?? null);
      if (city !== null && !canAdminCity(actor, city)) return error(status, 403, "forbidden");
      return globalStats(db, city);
    }, { query: t.Object({ city: t.Optional(citySchema) }) }))
  .get("/*", ({ request }) => staticFile(new URL(request.url).pathname));

export type App = typeof app;
