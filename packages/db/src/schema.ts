import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const locales = ["ru", "en"] as const;
export type Locale = (typeof locales)[number];

export const eventStatuses = ["draft", "published", "closed", "canceled"] as const;
export type EventStatus = (typeof eventStatuses)[number];

export const registrationStatuses = ["registered", "waitlisted", "canceled", "checked_in"] as const;
export type RegistrationStatus = (typeof registrationStatuses)[number];

export const waitlistOfferStatuses = ["pending", "accepted", "superseded"] as const;
export type WaitlistOfferStatus = (typeof waitlistOfferStatuses)[number];

const createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  username: text("username"),
  phone: text("phone"),
  locale: text("locale").$type<Locale>().notNull().default("ru"),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  isBanned: integer("is_banned", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
    location: text("location").notNull(),
    locationUrl: text("location_url"),
    capacity: integer("capacity"),
    status: text("status").$type<EventStatus>().notNull().default("draft"),
    createdBy: integer("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [index("events_status_starts_at_idx").on(table.status, table.startsAt)],
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
