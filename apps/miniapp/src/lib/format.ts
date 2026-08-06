import type { Locale } from "../api";
import { ru } from "../i18n/ru";
import type { MessageKey, Translate } from "../i18n";

const tags: Record<Locale, string> = { ru: "ru-RU", en: "en-GB" };

export const parseDate = (iso: string): Date => new Date(iso);

export const dayNumber = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(tags[locale], { day: "2-digit" }).format(parseDate(iso));

export const monthShort = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(tags[locale], { month: "short" })
    .format(parseDate(iso))
    .replace(".", "")
    .toUpperCase();

export const weekdayShort = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(tags[locale], { weekday: "short" })
    .format(parseDate(iso))
    .replace(".", "")
    .toUpperCase();

export const timeOf = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(tags[locale], { hour: "2-digit", minute: "2-digit", hour12: false }).format(parseDate(iso));

export const fullDate = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(tags[locale], {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parseDate(iso));

const DAY = 86_400_000;

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Сегодня" / "Завтра" for near dates, otherwise null. */
export const relativeDayKey = (iso: string, now: Date = new Date()): MessageKey | null => {
  const diff = Math.round((startOfDay(parseDate(iso)) - startOfDay(now)) / DAY);
  if (diff === 0) return "events.today";
  if (diff === 1) return "events.tomorrow";
  return null;
};

export const isPast = (iso: string, now: Date = new Date()): boolean => parseDate(iso).getTime() < now.getTime();

/** mm:ss while under an hour, then h:mm — chronograph style. */
export const countdown = (msLeft: number): string => {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
};

export const percent = (value: number): string => `${Math.round(value * 100)}%`;

export const bib = (id: number): string => String(id).padStart(3, "0");

export const fullName = (person: { firstName: string; lastName?: string | null }): string =>
  [person.firstName, person.lastName].filter(Boolean).join(" ");

const errorKeys = new Set(Object.keys(ru));

export const errorText = (t: Translate, error: unknown): string => {
  const code = error instanceof Error ? error.message : "request_failed";
  const key = `err.${code}`;
  return errorKeys.has(key) ? t(key as MessageKey) : t("err.request_failed");
};

/** ISO (UTC) -> value for <input type="datetime-local"> in the viewer's zone. */
export const toLocalInput = (iso: string): string => {
  const date = parseDate(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

export const fromLocalInput = (value: string): string => new Date(value).toISOString();
