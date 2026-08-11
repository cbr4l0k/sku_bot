import { InlineKeyboard, bold, format } from "gramio";
import { and, count, eq, events, inArray, registrations } from "@sku/db";
import type { Locale } from "@sku/db";

import { canSeeEvent } from "../core/groups";
import { db } from "../db";
import { loadEnv } from "../env";
import { i18n } from "./i18n";

const env = loadEnv();
const timezone = "Europe/Moscow";

type EventCardContext = {
  send: (text: string | ReturnType<typeof format>, params?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
};

export type EventChange = "title" | "description" | "startsAt" | "location" | "capacity";
export type EventUpdatedFields = { title?: string; description?: true; startsAt?: string; location?: string; capacity?: number | null };

type EventSummary = { title: string; date: string; description: string; location: string; locationUrl: string | null; capacity: number | null };

export const formatDate = (startsAt: Date, locale: Locale): string => new Intl.DateTimeFormat(
  locale === "ru" ? "ru-RU" : "en-US",
  { dateStyle: "long", timeStyle: "short", timeZone: timezone },
).format(startsAt);

const publishedEvent = (eventId: number) => db.select({
  id: events.id,
  title: events.title,
  startsAt: events.startsAt,
  location: events.location,
  locationUrl: events.locationUrl,
  capacity: events.capacity,
}).from(events).where(and(eq(events.id, eventId), eq(events.status, "published"))).get();

export const eventSummary = (eventId: number, locale: Locale): EventSummary | null => {
  const event = db.select({ title: events.title, description: events.description, startsAt: events.startsAt, location: events.location, locationUrl: events.locationUrl, capacity: events.capacity })
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  return event ? { ...event, date: formatDate(event.startsAt, locale) } : null;
};

export const sendEventCard = async (context: EventCardContext, eventId: number, userId: number, locale: Locale): Promise<void> => {
  const event = publishedEvent(eventId);
  // A deep link must not reveal an event the recipient's groups exclude them from.
  if (!event || !canSeeEvent(db, eventId, userId)) {
    await context.send(i18n.t(locale, "eventUnavailable"));
    return;
  }

  const date = formatDate(event.startsAt, locale);
  const confirmed = event.capacity === null ? null : db.select({ count: count() })
    .from(registrations)
    .where(and(
      eq(registrations.eventId, event.id),
      inArray(registrations.status, ["registered", "checked_in"]),
    ))
    .get()?.count ?? 0;
  const spots = event.capacity === null || confirmed === null ? null : Math.max(event.capacity - confirmed, 0);
  const spotsLine = spots === null ? "" : `\n${i18n.t(locale, "spotsLeft", spots)}`;

  await context.send(format`${bold(event.title)}

${i18n.t(locale, "eventDate", date)}
${i18n.t(locale, "eventLocation", event.location, event.locationUrl)}${spotsLine}`, {
    reply_markup: new InlineKeyboard().webApp(i18n.t(locale, "openEvent"), `https://${env.DOMAIN}/events/${event.id}`),
  });
};
