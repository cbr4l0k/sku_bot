import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";

import type { CityRole, CitySlug } from "@sku/cities";

export const locales = ["ru", "en"] as const;
export type Locale = (typeof locales)[number];

export const eventStatuses = ["draft", "published", "closed", "canceled"] as const;
export type EventStatus = (typeof eventStatuses)[number];

export const registrationStatuses = ["registered", "waitlisted", "canceled", "checked_in"] as const;
export type RegistrationStatus = (typeof registrationStatuses)[number];

export const ticketOrderStatuses = [
  "awaiting_payment",
  "payment_succeeded",
  "fulfilled",
  "cancel_pending",
  "canceled",
  "refund_pending",
  "refunded",
  "refund_failed",
] as const;
export type TicketOrderStatus = (typeof ticketOrderStatuses)[number];

export const paymentAttemptStatuses = ["pending", "succeeded", "canceled"] as const;
export type PaymentAttemptStatus = (typeof paymentAttemptStatuses)[number];

export const refundStatuses = ["pending", "succeeded", "canceled"] as const;
export type RefundStatus = (typeof refundStatuses)[number];

export const eventProductKinds = ["merchandise", "addon"] as const;
export type EventProductKind = (typeof eventProductKinds)[number];

export const orderItemKinds = ["ticket", ...eventProductKinds] as const;
export type OrderItemKind = (typeof orderItemKinds)[number];

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

/** Fixed, server-priced ticket choices for an event. No rows means the event is free. */
export const ticketTiers = sqliteTable(
  "ticket_tiers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Money is always stored as integer minor units: kopecks for RUB. */
    priceMinor: integer("price_minor").notNull(),
    quota: integer("quota"),
    salesStartAt: integer("sales_start_at", { mode: "timestamp" }),
    salesEndAt: integer("sales_end_at", { mode: "timestamp" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [index("ticket_tiers_event_id_sort_order_idx").on(table.eventId, table.sortOrder, table.id)],
);

/** Optional event-scoped products that can be bought alone or together with a ticket. */
export const eventProducts = sqliteTable(
  "event_products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind").$type<EventProductKind>().notNull().default("merchandise"),
    name: text("name").notNull(),
    description: text("description"),
    priceMinor: integer("price_minor").notNull(),
    /** Null stock means unlimited; sold quantities are reserved at checkout. */
    stock: integer("stock"),
    maxPerOrder: integer("max_per_order").notNull().default(1),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [index("event_products_event_id_sort_order_idx").on(table.eventId, table.sortOrder, table.id)],
);

/** Optional choices for a product, most commonly merchandise sizes. */
export const eventProductVariants = sqliteTable(
  "event_product_variants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: integer("product_id").notNull().references(() => eventProducts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Each option owns its inventory; null means unlimited. */
    stock: integer("stock"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index("event_product_variants_product_id_sort_order_idx").on(table.productId, table.sortOrder, table.id),
    uniqueIndex("event_product_variants_active_product_id_name_unique")
      .on(table.productId, table.name)
      .where(sql`${table.active} = true`),
  ],
);

/**
 * The durable purchase state machine. Provider responses are evidence attached in
 * payment_attempts/refunds; this row is the business decision about the basket.
 */
export const ticketOrders = sqliteTable(
  "ticket_orders",
  {
    id: text("id").primaryKey(),
    eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "restrict" }),
    ticketTierId: integer("ticket_tier_id").references(() => ticketTiers.id, { onDelete: "restrict" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    ticketName: text("ticket_name"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("RUB"),
    status: text("status").$type<TicketOrderStatus>().notNull().default("awaiting_payment"),
    /** Provider expiry is authoritative; a local timeout only asks ЮKassa to cancel. */
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    fulfilledAt: integer("fulfilled_at", { mode: "timestamp" }),
    canceledAt: integer("canceled_at", { mode: "timestamp" }),
    refundedAt: integer("refunded_at", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index("ticket_orders_event_status_idx").on(table.eventId, table.status),
    index("ticket_orders_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("ticket_orders_unsettled_event_user_unique")
      .on(table.eventId, table.userId)
      .where(sql`${table.status} = 'awaiting_payment'`),
  ],
);

/** Immutable price/name snapshots used for totals, receipts, inventory, and refunds. */
export const orderItems = sqliteTable(
  "order_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: text("order_id").notNull().references(() => ticketOrders.id, { onDelete: "cascade" }),
    ticketTierId: integer("ticket_tier_id").references(() => ticketTiers.id, { onDelete: "restrict" }),
    eventProductId: integer("event_product_id").references(() => eventProducts.id, { onDelete: "restrict" }),
    eventProductVariantId: integer("event_product_variant_id").references(() => eventProductVariants.id, { onDelete: "restrict" }),
    kind: text("kind").$type<OrderItemKind>().notNull(),
    name: text("name").notNull(),
    variantName: text("variant_name"),
    unitAmountMinor: integer("unit_amount_minor").notNull(),
    quantity: integer("quantity").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("order_items_order_id_idx").on(table.orderId),
    index("order_items_ticket_tier_id_idx").on(table.ticketTierId),
    index("order_items_event_product_id_idx").on(table.eventProductId),
    index("order_items_event_product_variant_id_idx").on(table.eventProductVariantId),
  ],
);

export const paymentAttempts = sqliteTable(
  "payment_attempts",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ticketOrders.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("yookassa"),
    providerPaymentId: text("provider_payment_id"),
    idempotenceKey: text("idempotence_key").notNull(),
    status: text("status").$type<PaymentAttemptStatus>().notNull().default("pending"),
    confirmationUrl: text("confirmation_url"),
    providerCreatedAt: text("provider_created_at"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    unique("payment_attempts_provider_payment_id_unique").on(table.providerPaymentId),
    unique("payment_attempts_idempotence_key_unique").on(table.idempotenceKey),
    index("payment_attempts_order_id_idx").on(table.orderId),
  ],
);

export const refunds = sqliteTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull().references(() => ticketOrders.id, { onDelete: "cascade" }),
    paymentAttemptId: text("payment_attempt_id").notNull().references(() => paymentAttempts.id, { onDelete: "restrict" }),
    providerRefundId: text("provider_refund_id"),
    idempotenceKey: text("idempotence_key").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    status: text("status").$type<RefundStatus>().notNull().default("pending"),
    reason: text("reason").notNull(),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    unique("refunds_provider_refund_id_unique").on(table.providerRefundId),
    unique("refunds_idempotence_key_unique").on(table.idempotenceKey),
    index("refunds_order_id_idx").on(table.orderId),
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
