import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "@sku/db";
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const slotAt = (now: Date) => Math.floor(seconds(now) / 45);
const signature = (secret: string, eventId: number, slot: number) => createHmac("sha256", secret).update(`${eventId}:${slot}`).digest("base64url").slice(0, 16);
export const mintCheckinToken = (secret: string, eventId: number, now: Date) => `skuchk.${eventId}.${slotAt(now)}.${signature(secret, eventId, slotAt(now))}`;
export const verifyCheckinToken = (secret: string, token: string, now: Date): { eventId: number } | null => {
  const match = /^skuchk\.([1-9]\d*)\.(\d+)\.([A-Za-z0-9_-]{16})$/.exec(token);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  const eventId = Number(match[1]); const slot = Number(match[2]); const current = slotAt(now);
  if (!Number.isSafeInteger(eventId) || !Number.isSafeInteger(slot) || (slot !== current && slot !== current - 1)) return null;
  const expected = Buffer.from(signature(secret, eventId, slot)); const actual = Buffer.from(match[3]);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? { eventId } : null;
};
type Registration = { id: number; status: string };
/** An event nobody has ended yet is still running, however long ago it started. */
export const isEventOver = (db: Db, eventId: number): boolean => {
  const event = db.$client.query<{ ended_at: number | null }, [number]>("SELECT ended_at FROM events WHERE id = ?").get(eventId);
  return !event || event.ended_at !== null;
};
export const checkIn = (db: Db, eventId: number, userId: number, now: Date): { ok: true } | { error: "not_registered" | "already_checked_in" | "event_over" } => db.$client.transaction((): { ok: true } | { error: "not_registered" | "already_checked_in" | "event_over" } => {
  // The scan closes when the organizer ends the event, not when its start time passes.
  if (isEventOver(db, eventId)) return { error: "event_over" };
  const registration = db.$client.query<Registration, [number, number]>("SELECT id, status FROM registrations WHERE event_id = ? AND user_id = ?").get(eventId, userId);
  if (!registration || registration.status === "waitlisted" || registration.status === "canceled") return { error: "not_registered" };
  if (registration.status === "checked_in") return { error: "already_checked_in" };
  db.$client.query("UPDATE registrations SET status = 'checked_in', checked_in_at = ?, updated_at = ? WHERE id = ?").run(seconds(now), seconds(now), registration.id);
  return { ok: true };
})();
/** Stays open after the event ends: fixing the roster afterwards is part of the job. */
export const manualToggleCheckin = (db: Db, eventId: number, userId: number, now: Date): { status: "registered" | "checked_in" } | { error: "not_registered" } => db.$client.transaction((): { status: "registered" | "checked_in" } | { error: "not_registered" } => {
  const registration = db.$client.query<Registration, [number, number]>("SELECT id, status FROM registrations WHERE event_id = ? AND user_id = ?").get(eventId, userId);
  if (!registration || (registration.status !== "registered" && registration.status !== "checked_in")) return { error: "not_registered" };
  const status = registration.status === "checked_in" ? "registered" : "checked_in";
  db.$client.query("UPDATE registrations SET status = ?, checked_in_at = ?, updated_at = ? WHERE id = ?").run(status, status === "checked_in" ? seconds(now) : null, seconds(now), registration.id);
  return { status };
})();

/* ------------------------------------------------------- runner-held tickets */

/**
 * The ticket a runner shows at the door. Unlike the organizer's rotating code
 * this binds the person as well as the event, and it deliberately does NOT
 * rotate: the runner is the one holding it, and demanding connectivity from
 * them at the exact moment they reach the door is the worst possible place to
 * demand it. Sharing is defeated by the scan being single-use against the
 * registration rather than by a short expiry — a forwarded screenshot lands on
 * "already checked in" and names whoever used it first.
 */
const ticketSignature = (secret: string, eventId: number, userId: number) =>
  createHmac("sha256", secret).update(`ticket:${eventId}:${userId}`).digest("base64url").slice(0, 22);

export const mintTicketToken = (secret: string, eventId: number, userId: number) =>
  `skutkt.${eventId}.${userId}.${ticketSignature(secret, eventId, userId)}`;

export const verifyTicketToken = (secret: string, token: string): { eventId: number; userId: number } | null => {
  const match = /^skutkt\.([1-9]\d*)\.([1-9]\d*)\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  const eventId = Number(match[1]);
  const userId = Number(match[2]);
  if (!Number.isSafeInteger(eventId) || !Number.isSafeInteger(userId)) return null;
  const expected = Buffer.from(ticketSignature(secret, eventId, userId));
  const actual = Buffer.from(match[3]);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? { eventId, userId } : null;
};

export type ScanOutcome =
  | { ok: true; alreadyCheckedIn: boolean; checkedInAt: Date }
  | { error: "not_registered" | "event_over" };

/**
 * The door scan. A second scan of the same ticket is not an error the organizer
 * needs to recover from — they still want to see who it is and what merch the
 * person is owed — so it reports `alreadyCheckedIn` instead of refusing.
 */
export const scanTicket = (db: Db, eventId: number, userId: number, now: Date): ScanOutcome =>
  db.$client.transaction((): ScanOutcome => {
    if (isEventOver(db, eventId)) return { error: "event_over" };
    const registration = db.$client
      .query<Registration & { checked_in_at: number | null }, [number, number]>(
        "SELECT id, status, checked_in_at FROM registrations WHERE event_id = ? AND user_id = ?",
      )
      .get(eventId, userId);
    if (!registration || registration.status === "waitlisted" || registration.status === "canceled") return { error: "not_registered" };
    if (registration.status === "checked_in") {
      return { ok: true, alreadyCheckedIn: true, checkedInAt: new Date((registration.checked_in_at ?? seconds(now)) * 1000) };
    }
    db.$client
      .query("UPDATE registrations SET status = 'checked_in', checked_in_at = ?, updated_at = ? WHERE id = ?")
      .run(seconds(now), seconds(now), registration.id);
    return { ok: true, alreadyCheckedIn: false, checkedInAt: now };
  })();

/**
 * Ticking a merch line off at the door. Toggles, because the commonest
 * correction is an organizer tapping the wrong row on a busy night.
 */
export const toggleHandover = (
  db: Db,
  eventId: number,
  itemId: number,
  organizerId: number,
  now: Date,
): { handedOverAt: Date | null } | { error: "item_not_found" } => {
  const item = db.$client
    .query<{ id: number; handed_over_at: number | null }, [number, number]>(
      `SELECT i.id, i.handed_over_at FROM order_items i
       JOIN ticket_orders o ON o.id = i.order_id
       WHERE i.id = ? AND o.event_id = ? AND i.kind != 'ticket'`,
    )
    .get(itemId, eventId);
  if (!item) return { error: "item_not_found" };
  const handedOver = item.handed_over_at === null;
  db.$client
    .query("UPDATE order_items SET handed_over_at = ?, handed_over_by = ? WHERE id = ?")
    .run(handedOver ? seconds(now) : null, handedOver ? organizerId : null, itemId);
  return { handedOverAt: handedOver ? now : null };
};
