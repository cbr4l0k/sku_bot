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
export const checkIn = (db: Db, eventId: number, userId: number, now: Date): { ok: true } | { error: "not_registered" | "already_checked_in" } => db.$client.transaction((): { ok: true } | { error: "not_registered" | "already_checked_in" } => {
  const registration = db.$client.query<Registration, [number, number]>("SELECT id, status FROM registrations WHERE event_id = ? AND user_id = ?").get(eventId, userId);
  if (!registration || registration.status === "waitlisted" || registration.status === "canceled") return { error: "not_registered" };
  if (registration.status === "checked_in") return { error: "already_checked_in" };
  db.$client.query("UPDATE registrations SET status = 'checked_in', checked_in_at = ?, updated_at = ? WHERE id = ?").run(seconds(now), seconds(now), registration.id);
  return { ok: true };
})();
export const manualToggleCheckin = (db: Db, eventId: number, userId: number, now: Date): { status: "registered" | "checked_in" } | { error: "not_registered" } => db.$client.transaction((): { status: "registered" | "checked_in" } | { error: "not_registered" } => {
  const registration = db.$client.query<Registration, [number, number]>("SELECT id, status FROM registrations WHERE event_id = ? AND user_id = ?").get(eventId, userId);
  if (!registration || (registration.status !== "registered" && registration.status !== "checked_in")) return { error: "not_registered" };
  const status = registration.status === "checked_in" ? "registered" : "checked_in";
  db.$client.query("UPDATE registrations SET status = ?, checked_in_at = ?, updated_at = ? WHERE id = ?").run(status, status === "checked_in" ? seconds(now) : null, seconds(now), registration.id);
  return { status };
})();
