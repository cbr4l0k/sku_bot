import type { Locale } from "../api";
import { ru } from "../i18n/ru";
import type { MessageKey, Translate } from "../i18n";

const tags: Record<Locale, string> = { ru: "ru-RU", en: "en-GB" };

export const parseDate = (iso: string): Date => new Date(iso);

export const dayNumber = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(tags[locale], { day: "2-digit" }).format(parseDate(iso));

/** Two-digit month, for the poster's stacked "05 / 08" date hero. */
export const monthNumber = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(tags[locale], { month: "2-digit" }).format(parseDate(iso));

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

/** Rubles without the kopecks unless there are some: "1 700 ₽". */
export const money = (minor: number, locale: Locale, currency = "RUB"): string =>
  new Intl.NumberFormat(tags[locale], {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);

/** "Пт 20.09" — the compact date the poster lines use. */
export const shortDate = (iso: string, locale: Locale): string => {
  const weekday = new Intl.DateTimeFormat(tags[locale], { weekday: "short" }).format(parseDate(iso)).replace(".", "");
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${dayNumber(iso, locale)}.${monthNumber(iso, locale)}`;
};

/** "12.09" — a date in a list row. */
export const dayMonth = (iso: string, locale: Locale): string => `${dayNumber(iso, locale)}.${monthNumber(iso, locale)}`;

/** "июля" / "July", for "since …" — Russian wants the genitive, which only the day format gives. */
export const monthSince = (iso: string, locale: Locale): string =>
  locale === "en"
    ? new Intl.DateTimeFormat(tags.en, { month: "long" }).format(parseDate(iso))
    : new Intl.DateTimeFormat(tags.ru, { day: "numeric", month: "long" }).format(parseDate(iso)).replace(/^\d+\s/, "");

/** "мая 2024" / "May 2024", for "in the club since …". */
export const monthYear = (iso: string, locale: Locale): string => `${monthSince(iso, locale)} ${parseDate(iso).getFullYear()}`;

/** Two letters for an avatar. */
export const initials = (person: { firstName: string; lastName?: string | null }): string =>
  [person.firstName, person.lastName ?? ""].map((part) => part.charAt(0)).join("").slice(0, 2).toUpperCase();

/** Whole days between two calendar dates in the viewer's zone. */
export const daysUntil = (iso: string, now: Date = new Date()): number =>
  Math.round((startOfDay(parseDate(iso)) - startOfDay(now)) / DAY);

/** Monday of the week the date falls in, as a day stamp — the key events group under. */
export const weekStart = (date: Date): number => {
  const day = startOfDay(date);
  const weekday = (new Date(day).getDay() + 6) % 7;
  return day - weekday * DAY;
};

/** Until the start, chronograph style: "02:14" (h:mm) inside a day, "3 д" beyond it. */
export const untilStart = (msLeft: number, dayLabel: (n: number) => string): string => {
  if (msLeft >= DAY) return dayLabel(Math.floor(msLeft / DAY));
  const totalMinutes = Math.max(0, Math.floor(msLeft / 60_000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`;
};

/** "четверг, 12 сентября" — the day without the time. */
export const longDay = (iso: string, locale: Locale): string =>
  new Intl.DateTimeFormat(tags[locale], { weekday: "long", day: "numeric", month: "long" }).format(parseDate(iso));

const englishSuffix = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
};

/** A place in a queue: "3-й" / "3rd". */
export const ordinal = (n: number, locale: Locale): string => (locale === "ru" ? `${n}-й` : `${n}${englishSuffix(n)}`);
