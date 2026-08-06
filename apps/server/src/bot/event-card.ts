import { InlineKeyboard, bold, format } from "gramio";
import { and, count, eq, events, inArray, registrations } from "@sku/db";
import type { Locale } from "@sku/db";

import { db } from "../db";
import { loadEnv } from "../env";
import { i18n } from "./i18n";

const env = loadEnv();
const timezone = "Europe/Moscow";

type EventCardContext = {
  send: (text: string | ReturnType<typeof format>, params?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
};

type EventSummary = { title: string; date: string };

const formatDate = (startsAt: Date, locale: Locale): string => new Intl.DateTimeFormat(
  locale === "ru" ? "ru-RU" : "en-US",
  { dateStyle: "long", timeStyle: "short", timeZone: timezone },
).format(startsAt);

const publishedEvent = (eventId: number) => db.select({
  id: events.id,
  title: events.title,
  startsAt: events.startsAt,
  location: events.location,
  capacity: events.capacity,
}).from(events).where(and(eq(events.id, eventId), eq(events.status, "published"))).get();

export const eventSummary = (eventId: number, locale: Locale): EventSummary | null => {
  const event = db.select({ title: events.title, startsAt: events.startsAt })
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  return event ? { title: event.title, date: formatDate(event.startsAt, locale) } : null;
};

export const sendEventCard = async (context: EventCardContext, eventId: number, locale: Locale): Promise<void> => {
  const event = publishedEvent(eventId);
  if (!event) {
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
${i18n.t(locale, "eventLocation", event.location)}${spotsLine}`, {
    reply_markup: new InlineKeyboard().webApp(i18n.t(locale, "openEvent"), `https://${env.DOMAIN}/events/${event.id}`),
  });
};
