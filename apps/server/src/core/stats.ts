import { Effect } from "effect";
import { CITIES, type CitySlug } from "@sku/cities";
import type { Db } from "@sku/db";
import { Database } from "../services";
type Registration = { event_id: number; user_id: number; status: string; is_staff: number };
export const eventStats = Effect.fnUntraced(function* (eventId: number) {
  const db = yield* Database;
  const all = db.$client.query<Registration, [number]>("SELECT event_id, user_id, status, is_staff FROM registrations WHERE event_id = ?").all(eventId);
  // Staff hold no spot, so they are counted apart: mixing them into "registered"
  // would flatter the attendance rate and understate how full a run really is.
  const registrations = all.filter((row) => row.is_staff === 0);
  const staff = all.filter((row) => row.is_staff === 1);
  const registered = registrations.filter((row) => row.status === "registered" || row.status === "checked_in").length;
  const checkedIn = registrations.filter((row) => row.status === "checked_in").length;
  const offers = db.$client.query<{ status: string }, [number]>("SELECT status FROM waitlist_offers WHERE event_id = ?").all(eventId);
  return { registered, waitlisted: registrations.filter((row) => row.status === "waitlisted").length, checkedIn, staff: staff.filter((row) => row.status !== "canceled").length, staffCheckedIn: staff.filter((row) => row.status === "checked_in").length, attendanceRate: registered ? checkedIn / registered : 0, offersMade: offers.length, offersAccepted: offers.filter((row) => row.status === "accepted").length };
});
/** Narrowed to one branch for a branch admin; the whole club when `city` is null. */
export const globalStats = Effect.fn("stats.globalStats")(function* (city: CitySlug | null = null) {
  const db = yield* Database;
  const events = city === null
    ? db.$client.query<{ id: number; capacity: number | null }, []>("SELECT id, capacity FROM events").all()
    : db.$client.query<{ id: number; capacity: number | null }, [string]>("SELECT id, capacity FROM events WHERE city = ?").all(city);
  const scope = new Set(events.map((row) => row.id));
  // Club-wide numbers describe the people the club serves, not the people
  // running it, so staff rows are left out of every one of them.
  const registrations = db.$client
    .query<Registration, []>("SELECT event_id, user_id, status, is_staff FROM registrations").all()
    .filter((row) => scope.has(row.event_id) && row.is_staff === 0);
  const confirmed = registrations.filter((row) => row.status === "registered" || row.status === "checked_in");
  const checkedIn = registrations.filter((row) => row.status === "checked_in");
  const capacityEvents = events.filter((row) => row.capacity !== null && row.capacity > 0);
  const counts = new Map<number, number>();
  for (const row of registrations) if (row.status !== "canceled") counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  const names = new Map(db.$client.query<{ id: number; first_name: string }, []>("SELECT id, first_name FROM users").all().map((row) => [row.id, row.first_name]));
  return { totalEvents: events.length, uniqueParticipants: counts.size, avgFillRate: capacityEvents.length ? capacityEvents.reduce((sum, event) => sum + confirmed.filter((row) => row.event_id === event.id).length / (event.capacity ?? 1), 0) / capacityEvents.length : 0, attendanceRate: confirmed.length ? checkedIn.length / confirmed.length : 0, topParticipants: [...counts.entries()].map(([userId, count]) => ({ userId, firstName: names.get(userId) ?? "", count })).sort((a, b) => b.count - a.count || a.userId - b.userId).slice(0, 10) };
});

/** How far `zone` runs ahead of UTC at `at`, in milliseconds. */
const zoneOffset = (at: Date, zone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(at.getTime() / 1000) * 1000;
};

/**
 * "<Month> in numbers": the calendar month `now` falls in, read in the branch's
 * own zone (Moscow for the whole club — every branch keeps its time today).
 *
 * Only runs that have already started count as held, and only published or
 * closed ones — a draft never happened and a canceled run did not either.
 * Turnout is check-ins over spots held at those runs; staff are left out, as
 * everywhere else in the club's numbers.
 */
export const monthStats = Effect.fn("stats.monthStats")(function* (city: CitySlug | null, now: Date) {
  const db = yield* Database;
  const zone = CITIES[city ?? "spb"].timezone;
  const local = new Date(now.getTime() + zoneOffset(now, zone));
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const startGuess = new Date(Date.UTC(year, month, 1));
  const start = Math.floor((startGuess.getTime() - zoneOffset(startGuess, zone)) / 1000);
  // `now` is always inside its own month, so it is also where the month stops.
  const end = Math.floor(now.getTime() / 1000);
  const row = db.$client.query<{ events: number; runners: number; held: number | null; checked_in: number | null }, (string | number)[]>(`
    WITH held AS (
      SELECT id FROM events
      WHERE status IN ('published', 'closed') AND starts_at >= ? AND starts_at < ? ${city === null ? "" : "AND city = ?"}
    )
    SELECT
      (SELECT count(*) FROM held) AS events,
      count(DISTINCT CASE WHEN r.status = 'checked_in' THEN r.user_id END) AS runners,
      sum(r.status IN ('registered', 'checked_in')) AS held,
      sum(r.status = 'checked_in') AS checked_in
    FROM held LEFT JOIN registrations r ON r.event_id = held.id AND r.is_staff = 0
  `).get(...(city === null ? [start, end] : [start, end, city]));
  const held = row?.held ?? 0;
  return {
    month: `${year}-${String(month + 1).padStart(2, "0")}`,
    events: row?.events ?? 0,
    runners: row?.runners ?? 0,
    turnout: held > 0 ? (row?.checked_in ?? 0) / held : null,
  };
});
