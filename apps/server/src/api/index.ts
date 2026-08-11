import { Elysia, t } from "elysia";

import {
  and,
  asc,
  desc,
  eq,
  eventOrganizers,
  events,
  gt,
  inArray,
  ne,
  or,
  registrations,
  sql,
  users,
  waitlistOffers,
} from "@sku/db";
import { bot } from "../bot";
import type { EventChange } from "../bot/event-card";
import { checkIn, manualToggleCheckin, mintCheckinToken, verifyCheckinToken } from "../core/checkin";
import { chatState, chatTitle, refreshChatStates, telegramMembership } from "../bot/membership";
import {
  canSeeEvent,
  chatsGatingUpcomingEvents,
  chatsOfEvent,
  refreshMemberships,
  setEventChats,
  visibleToUser,
} from "../core/membership";
import { botEventLink, miniAppEventLink } from "../core/links";
import { cancelRegistration, joinEvent } from "../core/registration";
import { eventStats, globalStats } from "../core/stats";
import { acceptOffer, cancelEvent, issueOffers, setCapacity } from "../core/waitlist";
import { db } from "../db";
import { loadEnv } from "../env";
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
type ErrorStatus = (code: 400 | 403 | 404 | 409, response: { error: string }) => { error: string };
const error = (status: unknown, code: 400 | 403 | 404 | 409, message: string) => (status as ErrorStatus)(code, { error: message });

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
  // Env-configured admins are admins even if their row predates the boot-time sync.
  isAdmin: user.isAdmin || adminIds.has(user.id),
  isBanned: user.isBanned,
  createdAt: iso(user.createdAt),
});

const eventView = (event: typeof events.$inferSelect) => ({
  ...event,
  groups: chatsOfEvent(db, event.id).map((id) => ({ id, title: chatTitle(id) ?? String(id) })),
  startsAt: event.startsAt.toISOString(),
  createdAt: event.createdAt.toISOString(),
  updatedAt: event.updatedAt.toISOString(),
});

const configuredChats = new Set(env.EVENT_GROUPS);
/** Only chats from the EVENT_GROUPS catalog may be assigned; stored rows outlive the catalog. */
const unknownGroup = (groups: readonly number[]) => groups.some((id) => !configuredChats.has(id));

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

const requireEventOrganizer = (eventId: number, userId: number, isAdmin: boolean) => isAdmin || Boolean(
  db.select({ eventId: eventOrganizers.eventId })
    .from(eventOrganizers)
    .where(and(eq(eventOrganizers.eventId, eventId), eq(eventOrganizers.userId, userId)))
    .get(),
);

const participantEvent = (eventId: number) => db.select().from(events)
  .where(and(eq(events.id, eventId), eq(events.status, "published"))).get();

const activeParticipantIds = (eventId: number) => db.select({ userId: registrations.userId })
  .from(registrations)
  .where(and(eq(registrations.eventId, eventId), inArray(registrations.status, ["registered", "checked_in", "waitlisted"])))
  .all()
  .map((row) => row.userId);

const eventFields = t.Object({
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

export const app = new Elysia()
  .get("/api/health", () => ({ ok: true }))
  .group("/api", (api) => api
    .use(auth)
    .get("/me", ({ user }) => {
      const isOrganizerOfAny = Boolean(db.select({ eventId: eventOrganizers.eventId }).from(eventOrganizers)
        .where(eq(eventOrganizers.userId, user.id)).get());
      return { ...userView(user), isOrganizerOfAny };
    })
    .patch("/me", ({ user, body }) => {
      db.update(users).set({
        ...(body.locale === undefined ? {} : { locale: body.locale }),
        ...(body.firstName === undefined ? {} : { firstName: body.firstName }),
        ...(body.lastName === undefined ? {} : { lastName: body.lastName }),
      }).where(eq(users.id, user.id)).run();
      const updated = db.select().from(users).where(eq(users.id, user.id)).get();
      return updated ? userView(updated) : userView(user);
    }, { body: t.Object({ locale: t.Optional(t.Union([t.Literal("ru"), t.Literal("en")])), firstName: t.Optional(t.String()), lastName: t.Optional(t.String()) }) })
    .get("/events", async ({ user }) => {
      const current = now();
      await syncMemberships(user.id, chatsGatingUpcomingEvents(db, current));
      return db.select().from(events)
        .where(and(eq(events.status, "published"), gt(events.startsAt, current), visibleToUser(user.id)))
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
      await syncMemberships(user.id, chatsOfEvent(db, params.id));
      const result = joinEvent(db, params.id, user.id, now());
      if ("error" in result) {
        const code = result.error === "already_joined" || result.error === "event_full" ? 409 : result.error === "not_eligible" ? 403 : 400;
        return error(status, code, result.error);
      }
      return result;
    }, { params: idParams })
    .post("/events/:id/cancel", ({ params, user, status }) => {
      if (user.isBanned) return error(status, 403, "banned");
      if (!participantEvent(params.id)) return error(status, 404, "event_not_found");
      const result = cancelRegistration(db, params.id, user.id, now());
      fireEffects(result.effects);
      return { ok: true };
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

    .get("/organizer/events", ({ user, isAdmin }) => {
      const selected = isAdmin
        ? db.select().from(events).orderBy(desc(events.startsAt)).all()
        : db.select({ event: events }).from(eventOrganizers).innerJoin(events, eq(eventOrganizers.eventId, events.id))
          .where(eq(eventOrganizers.userId, user.id)).orderBy(desc(events.startsAt)).all().map((row) => row.event);
      return selected.map(eventView);
    })
    .patch("/organizer/events/:id", ({ params, body, user, isAdmin, status }) => {
      const event = db.select().from(events).where(eq(events.id, params.id)).get();
      if (!event) return error(status, 404, "event_not_found");
      if (!requireEventOrganizer(params.id, user.id, isAdmin)) return error(status, 403, "forbidden");
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
    .get("/organizer/events/:id/attendance", ({ params, user, isAdmin, status }) => {
      if (!db.select({ id: events.id }).from(events).where(eq(events.id, params.id)).get()) return error(status, 404, "event_not_found");
      if (!requireEventOrganizer(params.id, user.id, isAdmin)) return error(status, 403, "forbidden");
      const attendance = db.select({ userId: users.id, firstName: users.firstName, lastName: users.lastName, username: users.username, phone: users.phone, status: registrations.status, checkedInAt: registrations.checkedInAt })
        .from(registrations).innerJoin(users, eq(registrations.userId, users.id)).where(eq(registrations.eventId, params.id)).orderBy(asc(registrations.createdAt)).all()
        .map((row) => ({ ...row, checkedInAt: iso(row.checkedInAt) }));
      return { registrations: attendance, counts: eventStats(db, params.id) };
    }, { params: idParams })
    .get("/organizer/events/:id/checkin-token", ({ params, user, isAdmin, status }) => {
      if (!db.select({ id: events.id }).from(events).where(eq(events.id, params.id)).get()) return error(status, 404, "event_not_found");
      if (!requireEventOrganizer(params.id, user.id, isAdmin)) return error(status, 403, "forbidden");
      return { token: mintCheckinToken(env.CHECKIN_SECRET, params.id, now()), expiresInSeconds: 45 };
    }, { params: idParams })
    .post("/organizer/events/:id/attendance/:userId", ({ params, user, isAdmin, status }) => {
      if (!db.select({ id: events.id }).from(events).where(eq(events.id, params.id)).get()) return error(status, 404, "event_not_found");
      if (!requireEventOrganizer(params.id, user.id, isAdmin)) return error(status, 403, "forbidden");
      const result = manualToggleCheckin(db, params.id, params.userId, now());
      return "error" in result ? error(status, 400, result.error) : result;
    }, { params: t.Object({ id: t.Numeric(), userId: t.Numeric() }) })

    .post("/admin/events", ({ body, user, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      const startsAt = parseDate(body.startsAt);
      if (!startsAt) return error(status, 400, "invalid_starts_at");
      const locationUrl = body.locationUrl === undefined ? null : parseLocationUrl(body.locationUrl);
      if (locationUrl === undefined) return error(status, 400, "invalid_location_url");
      if (body.groups && unknownGroup(body.groups)) return error(status, 400, "unknown_group");
      const { groups, ...fields } = body;
      const created = db.insert(events).values({ ...fields, locationUrl, startsAt, createdBy: user.id, status: body.status ?? "draft" }).returning().get();
      if (groups) setEventChats(db, created.id, groups);
      return eventView(created);
    }, { body: t.Intersect([eventFields, t.Object({ status: t.Optional(eventStatus), groups: t.Optional(t.Array(t.Integer())) })]) })
    .patch("/admin/events/:id", ({ params, body, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      const event = db.select().from(events).where(eq(events.id, params.id)).get();
      if (!event) return error(status, 404, "event_not_found");
      const startsAt = body.startsAt === undefined ? undefined : parseDate(body.startsAt);
      if (body.startsAt !== undefined && !startsAt) return error(status, 400, "invalid_starts_at");
      const locationUrl = body.locationUrl === undefined ? undefined : parseLocationUrl(body.locationUrl);
      if (body.locationUrl !== undefined && locationUrl === undefined) return error(status, 400, "invalid_location_url");
      if (body.groups && unknownGroup(body.groups)) return error(status, 400, "unknown_group");
      const changes: EventChange[] = [
        body.title !== undefined && body.title !== event.title ? "title" : null,
        body.description !== undefined && body.description !== event.description ? "description" : null,
        startsAt !== undefined && startsAt.getTime() !== event.startsAt.getTime() ? "startsAt" : null,
        (body.location !== undefined && body.location !== event.location) || (locationUrl !== undefined && locationUrl !== event.locationUrl) ? "location" : null,
        body.capacity !== undefined && body.capacity !== event.capacity ? "capacity" : null,
      ].filter((change): change is EventChange => change !== null);
      if (body.groups !== undefined) setEventChats(db, params.id, body.groups);
      if (body.title !== undefined || body.description !== undefined || startsAt !== undefined || body.location !== undefined || locationUrl !== undefined || body.status !== undefined || body.waitlistEnabled !== undefined) db.update(events).set({
        ...(body.title === undefined ? {} : { title: body.title }), ...(body.description === undefined ? {} : { description: body.description }), ...(startsAt === undefined ? {} : { startsAt }), ...(body.location === undefined ? {} : { location: body.location }), ...(locationUrl === undefined ? {} : { locationUrl }), ...(body.status === undefined ? {} : { status: body.status }), ...(body.waitlistEnabled === undefined ? {} : { waitlistEnabled: body.waitlistEnabled }), updatedAt: now(),
      }).where(eq(events.id, params.id)).run();
      if (body.capacity !== undefined) fireEffects(setCapacity(db, params.id, body.capacity, now()));
      // Switching the queue back on hands out the spots the dormant queue missed.
      if (body.waitlistEnabled === true && !event.waitlistEnabled) fireEffects(issueOffers(db, params.id, now()));
      if (body.status === "canceled" && event.status !== "canceled") {
        const result = cancelEvent(db, params.id);
        fireEffects(result.effects);
        void notifyEventCanceled(result.userIds, params.id).catch(console.error);
      }
      if (event.status !== "draft" && body.status !== "canceled" && changes.length) void notifyEventUpdated(activeParticipantIds(params.id), params.id, changes).catch(console.error);
      const updated = db.select().from(events).where(eq(events.id, params.id)).get();
      return updated ? eventView(updated) : error(status, 404, "event_not_found");
    }, { params: idParams, body: t.Intersect([eventPatchFields, t.Object({ status: t.Optional(eventStatus), groups: t.Optional(t.Array(t.Integer())) })]) })
    .delete("/admin/events/:id", ({ params, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      const event = db.select().from(events).where(eq(events.id, params.id)).get();
      if (!event) return error(status, 404, "event_not_found");
      if (event.status !== "draft") return error(status, 409, "only_drafts_can_be_deleted");
      db.delete(events).where(eq(events.id, params.id)).run();
      return { ok: true };
    }, { params: idParams })
    .put("/admin/events/:id/organizers", ({ params, body, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: events.id }).from(events).where(eq(events.id, params.id)).get()) return error(status, 404, "event_not_found");
      db.$client.transaction(() => {
        db.delete(eventOrganizers).where(eq(eventOrganizers.eventId, params.id)).run();
        for (const userId of [...new Set(body.userIds)]) db.insert(eventOrganizers).values({ eventId: params.id, userId }).run();
      })();
      return { userIds: [...new Set(body.userIds)] };
    }, { params: idParams, body: t.Object({ userIds: t.Array(t.Integer()) }) })
    .get("/admin/events/:id/stats", ({ params, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: events.id }).from(events).where(eq(events.id, params.id)).get()) return error(status, 404, "event_not_found");
      const stats = eventStats(db, params.id);
      return {
        ...stats,
        noShowRate: stats.registered ? (stats.registered - stats.checkedIn) / stats.registered : 0,
        waitlistConversion: stats.offersMade ? stats.offersAccepted / stats.offersMade : 0,
      };
    }, { params: idParams })
    .get("/admin/events/:id/link", async ({ params, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      if (!db.select({ id: events.id }).from(events).where(eq(events.id, params.id)).get()) return error(status, 404, "event_not_found");
      const username = bot.info?.username ?? (await bot.api.getMe()).username;
      if (!username) return error(status, 400, "bot_username_unavailable");
      return { miniAppLink: miniAppEventLink(username, "app", params.id), botLink: botEventLink(username, params.id) };
    }, { params: idParams })
    .get("/admin/users", ({ query, isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      const term = query.query?.trim();
      const predicate = term ? or(sql`${users.firstName} LIKE ${`%${term}%`}`, sql`${users.lastName} LIKE ${`%${term}%`}`, sql`${users.username} LIKE ${`%${term}%`}`, sql`${users.phone} LIKE ${`%${term}%`}`) : undefined;
      return db.select().from(users).where(predicate).orderBy(asc(users.firstName)).all().map((person) => ({
        ...userView(person),
        isConfiguredAdmin: adminIds.has(person.id),
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
    .get("/admin/groups", async ({ isAdmin, status }) => {
      if (!isAdmin) return error(status, 403, "forbidden");
      await refreshChatStates(env.EVENT_GROUPS);
      return { groups: env.EVENT_GROUPS.map((id) => ({ id, ...chatState(id) })) };
    })
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
    .get("/admin/stats", ({ isAdmin, status }) => isAdmin ? globalStats(db) : error(status, 403, "forbidden")))
  .get("/*", ({ request }) => staticFile(new URL(request.url).pathname));

export type App = typeof app;
