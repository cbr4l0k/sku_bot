import type { Db } from "@sku/db";
import type { NotificationEffect } from "./types";
import { issueOffers } from "./waitlist";
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
type JoinResult = { status: "registered" } | { status: "waitlisted"; position: number } | { error: "banned" | "not_published" | "already_joined" | "event_past" | "not_eligible" };
type EventRow = { capacity: number | null; status: string; starts_at: number };
type RegistrationRow = { id: number; status: string };

export const joinEvent = (db: Db, eventId: number, userId: number, now: Date): JoinResult => db.$client.transaction((): JoinResult => {
  const timestamp = seconds(now);
  const banned = db.$client.query<{ is_banned: number }, [number]>("SELECT is_banned FROM users WHERE id = ?").get(userId)?.is_banned;
  if (banned) return { error: "banned" };
  const event = db.$client.query<EventRow, [number]>("SELECT capacity, status, starts_at FROM events WHERE id = ?").get(eventId);
  if (!event || event.status !== "published") return { error: "not_published" };
  if (event.starts_at <= timestamp) return { error: "event_past" };
  const registration = db.$client.query<RegistrationRow, [number, number]>("SELECT id, status FROM registrations WHERE event_id = ? AND user_id = ?").get(eventId, userId);
  if (registration && registration.status !== "canceled") return { error: "already_joined" };
  // Restricted events admit only members of the listed groups (see core/groups.ts).
  const eligible = db.$client.query<{ ok: number }, [number, number, number]>(
    `SELECT (NOT EXISTS (SELECT 1 FROM event_groups WHERE event_id = ?)
       OR EXISTS (SELECT 1 FROM event_groups JOIN user_groups ON user_groups.group_name = event_groups.group_name
                  WHERE event_groups.event_id = ? AND user_groups.user_id = ?)) AS ok`,
  ).get(eventId, eventId, userId)?.ok;
  if (!eligible) return { error: "not_eligible" };
  const confirmed = db.$client.query<{ count: number }, [number]>("SELECT count(*) AS count FROM registrations WHERE event_id = ? AND status IN ('registered', 'checked_in')").get(eventId)?.count ?? 0;
  const reserved = db.$client.query<{ count: number }, [number, number]>("SELECT count(*) AS count FROM waitlist_offers WHERE event_id = ? AND status = 'pending' AND expires_at > ?").get(eventId, timestamp)?.count ?? 0;
  const status = event.capacity === null || event.capacity - confirmed - reserved > 0 ? "registered" : "waitlisted";
  if (registration) db.$client.query("UPDATE registrations SET status = ?, created_at = ?, updated_at = ?, checked_in_at = NULL WHERE id = ?").run(status, timestamp, timestamp, registration.id);
  else db.$client.query("INSERT INTO registrations (event_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(eventId, userId, status, timestamp, timestamp);
  if (status === "registered") return { status };
  const rows = db.$client.query<{ user_id: number }, [number]>("SELECT user_id FROM registrations WHERE event_id = ? AND status = 'waitlisted' ORDER BY created_at, id").all(eventId);
  return { status, position: rows.findIndex((row) => row.user_id === userId) + 1 };
})();

export const cancelRegistration = (db: Db, eventId: number, userId: number, now: Date): { effects: NotificationEffect[] } => db.$client.transaction((): { effects: NotificationEffect[] } => {
  const registration = db.$client.query<RegistrationRow, [number, number]>("SELECT id, status FROM registrations WHERE event_id = ? AND user_id = ?").get(eventId, userId);
  const wasConfirmed = registration?.status === "registered" || registration?.status === "checked_in";
  if (registration && registration.status !== "canceled") db.$client.query("UPDATE registrations SET status = 'canceled', updated_at = ?, checked_in_at = NULL WHERE id = ?").run(seconds(now), registration.id);
  db.$client.query("UPDATE waitlist_offers SET status = 'superseded' WHERE event_id = ? AND user_id = ? AND status = 'pending'").run(eventId, userId);
  return { effects: wasConfirmed ? issueOffers(db, eventId, now) : [] };
})();
