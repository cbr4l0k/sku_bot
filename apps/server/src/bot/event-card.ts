import { InlineKeyboard, bold, format } from "gramio";
import { CITIES, type CitySlug } from "@sku/cities";
import { and, count, eq, events, inArray, isNull, registrations } from "@sku/db";
import type { Locale } from "@sku/db";

import { canSeeEvent, chatsOfEvent, refreshMemberships } from "../core/membership";
import { db } from "../db";
import { loadEnv } from "../env";
import { joinCallback } from "./callbacks";
import { i18n } from "./i18n";
import { telegramMembership } from "./membership";

const env = loadEnv();

type EventCardContext = {
  send: (text: string | ReturnType<typeof format>, params?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
};

export type EventChange = "title" | "description" | "startsAt" | "location" | "capacity";
export type EventUpdatedFields = { title?: string; description?: true; startsAt?: string; location?: string; capacity?: number | null };

type EventSummary = { title: string; startsAt: Date; date: string; description: string; location: string; locationUrl: string | null; capacity: number | null; city: CitySlug };

/** A run reads at the time it actually starts, in its own branch's zone. */
export const formatDate = (startsAt: Date, locale: Locale, city: CitySlug): string => new Intl.DateTimeFormat(
  locale === "ru" ? "ru-RU" : "en-US",
  { dateStyle: "long", timeStyle: "short", timeZone: CITIES[city].timezone },
).format(startsAt);

/**
 * A deep link to an event its organizers have ended answers "unavailable" rather than
 * offering a sign-up nothing would accept.
 */
const publishedEvent = (eventId: number) => db.select({
  id: events.id,
  city: events.city,
  title: events.title,
  startsAt: events.startsAt,
  location: events.location,
  locationUrl: events.locationUrl,
  capacity: events.capacity,
  waitlistEnabled: events.waitlistEnabled,
}).from(events).where(and(eq(events.id, eventId), eq(events.status, "published"), isNull(events.endedAt))).get();

const confirmedCount = (eventId: number) => db.select({ count: count() }).from(registrations)
  .where(and(eq(registrations.eventId, eventId), inArray(registrations.status, ["registered", "checked_in"])))
  .get()?.count ?? 0;

const myRegistration = (eventId: number, userId: number) => db
  .select({ status: registrations.status })
  .from(registrations)
  .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)))
  .get();

/**
 * The card doubles as the bot's join screen: it states where the user stands and
 * carries the one action open to them — sign up, take a queue place, or nothing
 * at all when the event is full and its queue is off.
 */
export const renderEventCard = (eventId: number, userId: number, locale: Locale): { text: ReturnType<typeof format>; keyboard: InlineKeyboard } | null => {
  const event = publishedEvent(eventId);
  if (!event || !canSeeEvent(db, eventId, userId)) return null;

  const confirmed = confirmedCount(event.id);
  const spots = event.capacity === null ? null : Math.max(event.capacity - confirmed, 0);
  const full = spots !== null && spots === 0;
  const registration = myRegistration(event.id, userId);
  const status = registration?.status ?? null;
  const mine = status === "registered" || status === "checked_in" || status === "waitlisted";

  const lines = [
    spots === null ? null : i18n.t(locale, "spotsLeft", spots),
    status === "registered" ? i18n.t(locale, "cardRegistered") : null,
    status === "checked_in" ? i18n.t(locale, "cardCheckedIn") : null,
    status === "waitlisted" ? i18n.t(locale, "cardWaitlisted") : null,
    !mine && full && !event.waitlistEnabled ? i18n.t(locale, "noSpotsLeft") : null,
  ].filter((line): line is string => line !== null);

  const keyboard = new InlineKeyboard();
  if (!mine && (!full || event.waitlistEnabled)) {
    keyboard.text(i18n.t(locale, full ? "joinQueueButton" : "joinButton"), joinCallback.pack({ id: event.id })).row();
  }
  keyboard.webApp(i18n.t(locale, "openEvent"), `https://${env.DOMAIN}/events/${event.id}`);

  return {
    text: format`${bold(event.title)}

${i18n.t(locale, "eventCity", CITIES[event.city].name[locale])}
${i18n.t(locale, "eventDate", formatDate(event.startsAt, locale, event.city))}
${i18n.t(locale, "eventLocation", event.location, event.locationUrl)}${lines.length ? `\n${lines.join("\n")}` : ""}`,
    keyboard,
  };
};

export const eventSummary = (eventId: number, locale: Locale): EventSummary | null => {
  const event = db.select({ title: events.title, description: events.description, startsAt: events.startsAt, location: events.location, locationUrl: events.locationUrl, capacity: events.capacity, city: events.city })
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  return event ? { ...event, date: formatDate(event.startsAt, locale, event.city) } : null;
};

export const sendEventCard = async (context: EventCardContext, eventId: number, userId: number, locale: Locale): Promise<void> => {
  // A deep link must not reveal an event the recipient's chats exclude them from.
  await refreshMemberships(db, telegramMembership, userId, chatsOfEvent(db, eventId), new Date());
  const card = renderEventCard(eventId, userId, locale);
  if (!card) {
    await context.send(i18n.t(locale, "eventUnavailable"));
    return;
  }
  await context.send(card.text, { reply_markup: card.keyboard });
};
