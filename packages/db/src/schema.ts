import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

import type { CityRole, CitySlug } from "@sku/cities";

export const locales = ["ru", "en"] as const;
export type Locale = (typeof locales)[number];

export const eventStatuses = ["draft", "published", "closed", "canceled"] as const;
export type EventStatus = (typeof eventStatuses)[number];

export const registrationStatuses = ["registered", "waitlisted", "canceled", "checked_in"] as const;
export type RegistrationStatus = (typeof registrationStatuses)[number];

export const waitlistOfferStatuses = ["pending", "accepted", "superseded"] as const;
export type WaitlistOfferStatus = (typeof waitlistOfferStatuses)[number];

export const chatGuestStatuses = ["invited", "kept", "removed"] as const;
export type ChatGuestStatus = (typeof chatGuestStatuses)[number];

const createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  username: text("username"),
  phone: text("phone"),
  locale: text("locale").$type<Locale>().notNull().default("ru"),
  /** The branch whose runs they browse. Null until they have chosen one. */
  city: text("city").$type<CitySlug>(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  isBanned: integer("is_banned", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /**
     * The branch putting the run on. The column default exists only so the
     * migration can add it to live rows — the API always demands one explicitly,
     * so a Moscow organizer can never quietly file an event under Petersburg.
     */
    city: text("city").$type<CitySlug>().notNull().default("spb"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
    location: text("location").notNull(),
    locationUrl: text("location_url"),
    capacity: integer("capacity"),
    /** With the queue off, a full event simply stops accepting registrations. */
    waitlistEnabled: integer("waitlist_enabled", { mode: "boolean" }).notNull().default(true),
    status: text("status").$type<EventStatus>().notNull().default("draft"),
    /**
     * When an organizer declared the event over. The clock never sets this: an event
     * stays live — joinable, and open for check-in — until someone running it says so.
     */
    endedAt: integer("ended_at", { mode: "timestamp" }),
    /**
     * The chat everyone holding a spot is invited into, independent of the
     * `event_chats` visibility gate: an event open to the whole world can still
     * funnel its runners into one group. Null means nobody is invited anywhere.
     */
    homeChatId: integer("home_chat_id"),
    createdBy: integer("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [index("events_city_status_starts_at_idx").on(table.city, table.status, table.startsAt)],
);

/**
 * Telegram chats an event is limited to. An event with no rows here is open to
 * everyone; the catalog of assignable chat ids lives in the EVENT_GROUPS env var.
 */
export const eventChats = sqliteTable(
  "event_chats",
  {
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    chatId: integer("chat_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.chatId] })],
);

/**
 * Cache of Telegram's getChatMember answers. Membership lives in Telegram, not
 * here — these rows only exist so the event queries can filter in SQL, and they
 * are refreshed on read once older than the TTL in core/membership.ts.
 */
export const chatMembers = sqliteTable(
  "chat_members",
  {
    chatId: integer("chat_id").notNull(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    isMember: integer("is_member", { mode: "boolean" }).notNull(),
    checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.userId] })],
);

export const eventOrganizers = sqliteTable(
  "event_organizers",
  {
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.userId] })],
);

export const registrations = sqliteTable(
  "registrations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").$type<RegistrationStatus>().notNull().default("registered"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    checkedInAt: integer("checked_in_at", { mode: "timestamp" }),
  },
  (table) => [
    unique("registrations_event_id_user_id_unique").on(table.eventId, table.userId),
    index("registrations_event_id_status_idx").on(table.eventId, table.status),
    index("registrations_user_id_idx").on(table.userId),
  ],
);

export const waitlistOffers = sqliteTable(
  "waitlist_offers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    offeredAt: integer("offered_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    status: text("status").$type<WaitlistOfferStatus>().notNull().default("pending"),
    cascaded: integer("cascaded", { mode: "boolean" }).notNull().default(false),
    messageId: integer("message_id"),
  },
  (table) => [
    index("waitlist_offers_event_id_status_expires_at_idx").on(table.eventId, table.status, table.expiresAt),
  ],
);

/**
 * Someone the bot let into a chat who was not there before — a guest on trial.
 * They stay if they check in and are removed if they never show up, which is why
 * the row exists at all: it is the only record of who arrived through us, and so
 * marks the only people we may ever remove. A long-standing member never gets one.
 *
 * One row per person per chat, not per event: `eventId` is whichever event the
 * trial currently hangs on. Someone holding spots at two runs who skips the first
 * has their trial carried over to the second rather than settled, so booking
 * repeatedly can never buy a permanent seat without ever turning up.
 */
export const chatGuests = sqliteTable(
  "chat_guests",
  {
    chatId: integer("chat_id").notNull(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    /** Kept so an unused single-use link can be revoked once the trial is settled. */
    inviteLink: text("invite_link").notNull(),
    status: text("status").$type<ChatGuestStatus>().notNull().default("invited"),
    createdAt: createdAt(),
    settledAt: integer("settled_at", { mode: "timestamp" }),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.userId] }),
    index("chat_guests_event_id_status_idx").on(table.eventId, table.status),
  ],
);

/**
 * Who runs what, one branch at a time. The primary key allows a single hold per
 * person per branch, so a role is set rather than accumulated — but nothing stops
 * the same person running Moscow and helping out in Kazan.
 *
 * This sits *beneath* `users.is_admin`: a general admin needs no rows here and is
 * never restricted by their absence.
 */
export const userCityRoles = sqliteTable(
  "user_city_roles",
  {
    city: text("city").$type<CitySlug>().notNull(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<CityRole>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.city, table.userId] }),
    index("user_city_roles_user_id_idx").on(table.userId),
  ],
);

/**
 * The Telegram chats the club can point events at — the catalog that used to be
 * the EVENT_GROUPS env var, and so used to need a redeploy to change.
 *
 * The bot files a row itself the moment it is added to a chat; a general admin
 * then says which branch it belongs to. Until they do, `city` is null and the
 * chat cannot be used for anything, which is what makes accidental discovery safe.
 *
 * `title`, `problem` and `checkedAt` are the answers Telegram last gave about the
 * chat. They live here rather than in memory so a restart does not blank every
 * chat name in the admin UI.
 */
export const chats = sqliteTable("chats", {
  /** The Telegram chat id. Carried over by `migrateChat` when a group is upgraded. */
  id: integer("id").primaryKey(),
  city: text("city").$type<CitySlug>(),
  title: text("title"),
  /** Why the last lookup failed, for the admin UI's warning state. Null when healthy. */
  problem: text("problem"),
  checkedAt: integer("checked_at", { mode: "timestamp" }),
  createdAt: createdAt(),
});
