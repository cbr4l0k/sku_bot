import type { CheckinMethod, Db } from "@sku/db";
import { adminCities, type Actor } from "./cities";
import { eventStats } from "./stats";

const DAY_SECONDS = 24 * 60 * 60;
/** Door duty starts before the gun: runners check in while the organizer sets up. */
export const START_LEAD_SECONDS = 60 * 60;
/**
 * Nothing ends an event but a person, so a run nobody closed stays "live" forever.
 * Six hours after the start is longer than any club run lasts; past that it stops
 * counting as live and turns into a reminder to press "end".
 */
export const STALE_AFTER_SECONDS = 6 * 60 * 60;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const isoAt = (value: number | null) => value === null ? null : new Date(value * 1000).toISOString();

/**
 * The one screen of an event in its four phases, plus the dead end. Status wins
 * over the clock — a draft is a draft however late it is, and an ended event is
 * in wrap-up even if it ended early — then the start phase opens an hour ahead.
 */
export type EventPhase = "draft" | "signup" | "start" | "wrapup" | "canceled";
type PhaseRow = { status: string; starts_at: number; ended_at: number | null };
const phaseOf = (event: PhaseRow, now: number): EventPhase => {
  if (event.status === "canceled") return "canceled";
  if (event.status === "draft") return "draft";
  if (event.ended_at !== null) return "wrapup";
  return now >= event.starts_at - START_LEAD_SECONDS ? "start" : "signup";
};
export const eventPhase = (event: { status: string; startsAt: Date; endedAt: Date | null }, now: Date): EventPhase =>
  phaseOf({ status: event.status, starts_at: seconds(event.startsAt), ended_at: event.endedAt && seconds(event.endedAt) }, seconds(now));

/* ------------------------------------------------------------------ scope */

/** The same reach as the organizer event list: branches they run, plus runs they are named on. */
const eventScope = (actor: Actor): { sql: string; params: (string | number)[] } => {
  if (actor.isGlobalAdmin) return { sql: "1 = 1", params: [] };
  const cities = adminCities(actor);
  return {
    sql: `(${cities.length ? `e.city IN (${cities.map(() => "?").join(", ")}) OR ` : ""}EXISTS (
      SELECT 1 FROM event_organizers o WHERE o.event_id = e.id AND o.user_id = ?))`,
    params: [...cities, actor.userId],
  };
};

/* ---------------------------------------------------------------- shared bits */

/** Something was for sale — the events whose door is a ticket scan rather than a QR. */
const isTicketed = (db: Db, eventId: number) => Boolean(db.$client.query<{ ok: number }, [number, number]>(`
  SELECT EXISTS (SELECT 1 FROM ticket_tiers WHERE event_id = ?)
    OR EXISTS (SELECT 1 FROM event_products WHERE event_id = ?) AS ok
`).get(eventId, eventId)?.ok);

/** Settled money only, the same rule as seriesStats: refunded and refunding orders are not revenue. */
const revenueMinor = (db: Db, eventId: number) => db.$client.query<{ value: number | null }, [number]>(`
  SELECT sum(i.unit_amount_minor * i.quantity) AS value
  FROM ticket_orders o JOIN order_items i ON i.order_id = o.id
  WHERE o.event_id = ? AND o.status IN ('payment_succeeded', 'fulfilled')
`).get(eventId)?.value ?? 0;

/**
 * First time in the club: no check-in, as anyone and anywhere, at an event that
 * started before this one. Signing up and not coming does not count as a visit.
 */
const firstTimerIds = (db: Db, eventId: number) => new Set(db.$client.query<{ user_id: number }, [number]>(`
  SELECT r.user_id FROM registrations r JOIN events e ON e.id = r.event_id
  WHERE r.event_id = ? AND r.is_staff = 0 AND NOT EXISTS (
    SELECT 1 FROM registrations p JOIN events pe ON pe.id = p.event_id
    WHERE p.user_id = r.user_id AND p.status = 'checked_in'
      AND p.event_id <> r.event_id AND pe.starts_at < e.starts_at
  )
`).all(eventId).map((row) => row.user_id));

/** Holds their spot because they took a waitlist offer rather than a free one. */
const fromWaitlistIds = (db: Db, eventId: number) => new Set(db.$client.query<{ user_id: number }, [number]>(
  "SELECT DISTINCT user_id FROM waitlist_offers WHERE event_id = ? AND status = 'accepted'",
).all(eventId).map((row) => row.user_id));

/** Per-person roster flags, keyed by user id. */
export const rosterFlags = (db: Db, eventId: number) => {
  const firstTimers = firstTimerIds(db, eventId);
  const fromWaitlist = fromWaitlistIds(db, eventId);
  return (userId: number) => ({ firstTime: firstTimers.has(userId), fromWaitlist: fromWaitlist.has(userId) });
};

/** Only a current check-in has a method; an undone one leaves a stale value behind. */
export const checkinMethodOf = (status: string, method: CheckinMethod | null) => status === "checked_in" ? method : null;

/* ---------------------------------------------------------------------- HQ */

type ScopedEvent = PhaseRow & {
  id: number;
  title: string;
  city: string;
  location: string;
  capacity: number | null;
  series_id: number | null;
};

/**
 * The organizer's front page: what is running, what needs a person, what is next.
 * Canceled and ended events are history and never appear here.
 */
export const hqOverview = (db: Db, actor: Actor, now: Date, nextLimit = 10) => {
  const timestamp = seconds(now);
  const scope = eventScope(actor);
  const rows = db.$client.query<ScopedEvent, (string | number)[]>(`
    SELECT e.id, e.title, e.city, e.location, e.capacity, e.series_id, e.status, e.starts_at, e.ended_at
    FROM events e
    WHERE e.status <> 'canceled' AND e.ended_at IS NULL AND ${scope.sql}
    ORDER BY e.starts_at, e.id
  `).all(...scope.params);

  const live = [];
  const todo: (
    | { kind: "publish_draft"; eventId: number; title: string; startsAt: string; seriesId: number }
    | { kind: "end_event"; eventId: number; title: string; startsAt: string; hoursSinceStart: number }
  )[] = [];
  const next = [];
  for (const event of rows) {
    const phase = phaseOf(event, timestamp);
    const startsAt = new Date(event.starts_at * 1000).toISOString();
    if (phase === "start" && timestamp >= event.starts_at + STALE_AFTER_SECONDS) {
      todo.push({ kind: "end_event", eventId: event.id, title: event.title, startsAt, hoursSinceStart: Math.floor((timestamp - event.starts_at) / 3600) });
      continue;
    }
    if (phase === "start") {
      const counts = eventStats(db, event.id);
      live.push({
        id: event.id,
        title: event.title,
        city: event.city,
        location: event.location,
        startsAt,
        ticketed: isTicketed(db, event.id),
        checkedIn: counts.checkedIn,
        total: counts.registered,
        // Negative while the door is open but the run has not started yet.
        minutesSinceStart: Math.floor((timestamp - event.starts_at) / 60),
      });
      continue;
    }
    // A draft whose date already passed was never going to be run; it is not "next".
    if (event.starts_at <= timestamp) continue;
    if (phase === "draft" && event.series_id !== null) {
      todo.push({ kind: "publish_draft", eventId: event.id, title: event.title, startsAt, seriesId: event.series_id });
    }
    if (next.length >= nextLimit) continue;
    const counts = eventStats(db, event.id);
    const ticketed = isTicketed(db, event.id);
    next.push({
      id: event.id,
      title: event.title,
      city: event.city,
      startsAt,
      phase,
      signupClosed: event.status === "closed",
      capacity: event.capacity,
      registered: counts.registered,
      waitlisted: counts.waitlisted,
      ticketed,
      revenueMinor: ticketed ? revenueMinor(db, event.id) : null,
    });
  }
  return { live, todo, next };
};

/* ------------------------------------------------------------- series list */

export const seriesSummary = (db: Db, seriesId: number, now: Date) => {
  const timestamp = seconds(now);
  const series = db.$client.query<{ active: number; next_starts_at: number | null; updated_at: number }, [number]>(
    "SELECT active, next_starts_at, updated_at FROM event_series WHERE id = ?",
  ).get(seriesId);
  // "Held" means someone ran it and said it was over; a canceled run was not held.
  // One grouped pass over the held runs rather than a roster load per run: a
  // weekly series is fifty of these a year.
  const held = db.$client.query<{ registered: number; checked_in: number }, [number]>(`
    SELECT
      count(CASE WHEN r.is_staff = 0 AND r.status IN ('registered', 'checked_in') THEN 1 END) AS registered,
      count(CASE WHEN r.is_staff = 0 AND r.status = 'checked_in' THEN 1 END) AS checked_in
    FROM events e LEFT JOIN registrations r ON r.event_id = e.id
    WHERE e.series_id = ? AND e.ended_at IS NOT NULL AND e.status <> 'canceled'
    GROUP BY e.id
  `).all(seriesId);
  const upcoming = db.$client.query<{ id: number; starts_at: number; status: string }, [number, number]>(`
    SELECT id, starts_at, status FROM events
    WHERE series_id = ? AND status <> 'canceled' AND ended_at IS NULL AND starts_at > ?
    ORDER BY starts_at, id LIMIT 1
  `).get(seriesId, timestamp);
  const leaders = db.$client.query<{ first_name: string }, [number]>(`
    SELECT u.first_name FROM series_organizers o JOIN users u ON u.id = o.user_id
    WHERE o.series_id = ? ORDER BY u.first_name
  `).all(seriesId).map((row) => row.first_name);
  // Same policy as seriesStats' held-only turnout: an empty held run counts as 0%.
  const rates = held.map((row) => (row.registered ? row.checked_in / row.registered : 0));
  const nextUp = upcoming?.starts_at ?? series?.next_starts_at ?? null;
  const active = Boolean(series?.active);
  return {
    held: held.length,
    avgTurnout: rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null,
    leaders,
    status: !active ? "paused" as const
      : upcoming?.status === "draft" ? "draft_ready" as const
        : nextUp !== null ? "scheduled" as const : "no_date" as const,
    nextUp: isoAt(nextUp),
    nextEventId: upcoming?.id ?? null,
    // The template's last edit; pausing is an edit, and nothing records it more precisely.
    pausedSince: active ? null : isoAt(series?.updated_at ?? null),
  };
};

/* ---------------------------------------------------------- event summary */

/**
 * Everything the event screen shows that is not already on the event itself or
 * the roster: the phase, the headline numbers, the money, the leftovers to hand
 * out, who a cancellation would reach, and what comes next in the series.
 */
export const eventSummary = (db: Db, eventId: number, now: Date) => {
  const timestamp = seconds(now);
  const event = db.$client.query<PhaseRow & { series_id: number | null }, [number]>(
    "SELECT status, starts_at, ended_at, series_id FROM events WHERE id = ?",
  ).get(eventId);
  if (!event) return null;
  const counts = eventStats(db, eventId);
  const ticketed = isTicketed(db, eventId);

  const confirmed = db.$client.query<{ user_id: number; status: string }, [number]>(
    "SELECT user_id, status FROM registrations WHERE event_id = ? AND is_staff = 0 AND status IN ('registered', 'checked_in')",
  ).all(eventId);
  const firstTimers = firstTimerIds(db, eventId);
  const newcomers = confirmed.filter((row) => firstTimers.has(row.user_id));
  const newcomersCame = newcomers.filter((row) => row.status === "checked_in").length;

  // Lines still owed at the door, from the same orders the roster lists them for.
  const outstanding = db.$client.query<{ name: string; variant_name: string | null; quantity: number; people: number }, [number]>(`
    SELECT i.name, i.variant_name, sum(i.quantity) AS quantity, count(DISTINCT o.user_id) AS people
    FROM order_items i JOIN ticket_orders o ON o.id = i.order_id
    WHERE o.event_id = ? AND i.kind <> 'ticket' AND i.handed_over_at IS NULL
      AND o.status IN ('fulfilled', 'refund_pending', 'refund_failed')
    GROUP BY i.name, i.variant_name ORDER BY i.name, i.variant_name
  `).all(eventId);
  const owedPeople = db.$client.query<{ value: number }, [number]>(`
    SELECT count(DISTINCT o.user_id) AS value
    FROM order_items i JOIN ticket_orders o ON o.id = i.order_id
    WHERE o.event_id = ? AND i.kind <> 'ticket' AND i.handed_over_at IS NULL
      AND o.status IN ('fulfilled', 'refund_pending', 'refund_failed')
  `).get(eventId)?.value ?? 0;

  const sold = db.$client.query<{ kind: string; name: string; quantity: number }, [number]>(`
    SELECT i.kind, CASE WHEN i.kind = 'ticket' THEN '' ELSE i.name END AS name, sum(i.quantity) AS quantity
    FROM order_items i JOIN ticket_orders o ON o.id = i.order_id
    WHERE o.event_id = ? AND o.status IN ('payment_succeeded', 'fulfilled')
    GROUP BY 1, 2 ORDER BY 1 DESC, 2
  `).all(eventId);
  const refunds = db.$client.query<{ count: number; amount: number | null }, [number]>(`
    SELECT count(*) AS count, sum(f.amount_minor) AS amount
    FROM refunds f JOIN ticket_orders o ON o.id = f.order_id
    WHERE o.event_id = ? AND f.status = 'succeeded'
  `).get(eventId);
  const pendingRefunds = db.$client.query<{ value: number }, [number]>(
    "SELECT count(*) AS value FROM ticket_orders WHERE event_id = ? AND status = 'refund_pending'",
  ).get(eventId)?.value ?? 0;

  return {
    phase: phaseOf(event, timestamp),
    ticketed,
    signupClosed: event.status === "closed",
    // Negative once the run has started.
    minutesToStart: Math.ceil((event.starts_at - timestamp) / 60),
    counts: {
      registered: counts.registered,
      waitlisted: counts.waitlisted,
      checkedIn: counts.checkedIn,
      noShows: counts.registered - counts.checkedIn,
      staff: counts.staff,
      turnout: counts.registered ? counts.checkedIn / counts.registered : null,
    },
    newcomers: {
      registered: newcomers.length,
      came: newcomersCame,
      missed: newcomers.length - newcomersCame,
      // Trials the bot settled by removing them from the chat after a no-show.
      removedFromChat: db.$client.query<{ value: number }, [number]>(
        "SELECT count(*) AS value FROM chat_guests WHERE event_id = ? AND status = 'removed'",
      ).get(eventId)?.value ?? 0,
    },
    money: ticketed ? {
      revenueMinor: revenueMinor(db, eventId),
      ticketsSold: sold.filter((row) => row.kind === "ticket").reduce((sum, row) => sum + row.quantity, 0),
      itemsSold: sold.filter((row) => row.kind !== "ticket").map((row) => ({ name: row.name, quantity: row.quantity })),
      refunds: { count: refunds?.count ?? 0, amountMinor: refunds?.amount ?? 0, pending: pendingRefunds },
    } : null,
    merchOutstanding: {
      people: owedPeople,
      lines: outstanding.map((row) => ({ name: row.name, variantName: row.variant_name, quantity: row.quantity, people: row.people })),
    },
    // Exactly who cancelEvent notifies: everyone holding or queueing for a spot, staff aside.
    cancelPreview: { registered: counts.registered, waitlisted: counts.waitlisted },
    nextInSeries: event.series_id === null ? null : nextInSeries(db, event.series_id, event.starts_at),
  };
};

const nextInSeries = (db: Db, seriesId: number, after: number) => {
  const series = db.$client.query<{ title: string; active: number; next_starts_at: number | null; lead_days: number }, [number]>(
    "SELECT title, active, next_starts_at, lead_days FROM event_series WHERE id = ?",
  ).get(seriesId);
  if (!series) return null;
  const occurrence = db.$client.query<PhaseRow & { id: number }, [number, number]>(`
    SELECT id, status, starts_at, ended_at FROM events
    WHERE series_id = ? AND starts_at > ? AND status <> 'canceled'
    ORDER BY starts_at, id LIMIT 1
  `).get(seriesId, after);
  if (occurrence) {
    return { seriesId, title: series.title, active: Boolean(series.active), eventId: occurrence.id, startsAt: isoAt(occurrence.starts_at), draftAt: null };
  }
  // Not spawned yet: the date a human approved, and when its draft will appear —
  // but only if it actually comes after this run.
  const startsAt = series.active && series.next_starts_at !== null && series.next_starts_at > after ? series.next_starts_at : null;
  return {
    seriesId,
    title: series.title,
    active: Boolean(series.active),
    eventId: null,
    startsAt: isoAt(startsAt),
    draftAt: isoAt(startsAt === null ? null : startsAt - series.lead_days * DAY_SECONDS),
  };
};
