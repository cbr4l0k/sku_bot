import type { Db } from "@sku/db";
import type { NotificationEffect, OfferEffect, SupersededEffect } from "./types";

const OFFER_WINDOW_SECONDS = 20 * 60;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
type EventRow = { id: number; capacity: number | null };
type OfferRow = { id: number; event_id: number; user_id: number; expires_at: number; message_id: number | null };

const transaction = <T>(db: Db, work: () => T): T => db.$client.transaction(work)();
const event = (db: Db, eventId: number) => db.$client.query<EventRow, [number]>("SELECT id, capacity FROM events WHERE id = ?").get(eventId);
const confirmed = (db: Db, eventId: number) => db.$client.query<{ count: number }, [number]>("SELECT count(*) AS count FROM registrations WHERE event_id = ? AND status IN ('registered', 'checked_in')").get(eventId)?.count ?? 0;
const reserved = (db: Db, eventId: number, now: number) => db.$client.query<{ count: number }, [number, number]>("SELECT count(*) AS count FROM waitlist_offers WHERE event_id = ? AND status = 'pending' AND expires_at > ?").get(eventId, now)?.count ?? 0;
const free = (db: Db, eventId: number, now: number) => {
  const current = event(db, eventId);
  return !current || current.capacity === null ? null : current.capacity - confirmed(db, eventId) - reserved(db, eventId, now);
};

const supersede = (db: Db, eventId: number, exceptOfferId?: number): SupersededEffect[] => {
  const sql = `SELECT id, event_id, user_id, expires_at, message_id FROM waitlist_offers WHERE event_id = ? AND status = 'pending'${exceptOfferId === undefined ? "" : " AND id <> ?"}`;
  const offers = exceptOfferId === undefined ? db.$client.query<OfferRow, [number]>(sql).all(eventId) : db.$client.query<OfferRow, [number, number]>(sql).all(eventId, exceptOfferId);
  if (offers.length) {
    const update = `UPDATE waitlist_offers SET status = 'superseded' WHERE event_id = ? AND status = 'pending'${exceptOfferId === undefined ? "" : " AND id <> ?"}`;
    if (exceptOfferId === undefined) db.$client.query(update).run(eventId);
    else db.$client.query(update).run(eventId, exceptOfferId);
  }
  return offers.map((offer) => ({ kind: "offer_superseded", offerId: offer.id, userId: offer.user_id, eventId: offer.event_id, messageId: offer.message_id }));
};

const issue = (db: Db, eventId: number, now: number): OfferEffect[] => {
  const effects: OfferEffect[] = [];
  while (free(db, eventId, now) === null || (free(db, eventId, now) ?? 0) > 0) {
    const candidate = db.$client.query<{ user_id: number }, [number]>(`SELECT r.user_id FROM registrations r WHERE r.event_id = ? AND r.status = 'waitlisted' AND NOT EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.event_id = r.event_id AND o.user_id = r.user_id AND o.status = 'pending') ORDER BY r.created_at, r.id LIMIT 1`).get(eventId);
    if (!candidate) break;
    const expiresAt = now + OFFER_WINDOW_SECONDS;
    const result = db.$client.query("INSERT INTO waitlist_offers (event_id, user_id, offered_at, expires_at) VALUES (?, ?, ?, ?) RETURNING id").get(eventId, candidate.user_id, now, expiresAt) as { id: number };
    effects.push({ kind: "offer_created", offerId: result.id, userId: candidate.user_id, eventId, expiresAt: new Date(expiresAt * 1000) });
  }
  return effects;
};

export const issueOffers = (db: Db, eventId: number, now: Date) => transaction(db, () => issue(db, eventId, seconds(now)));

export const sweepOffers = (db: Db, now: Date) => transaction(db, () => {
  const timestamp = seconds(now);
  const expired = db.$client.query<OfferRow, [number]>("SELECT id, event_id, user_id, expires_at, message_id FROM waitlist_offers WHERE status = 'pending' AND expires_at <= ? AND cascaded = false").all(timestamp);
  const effects: OfferEffect[] = [];
  for (const offer of expired) {
    db.$client.query("UPDATE waitlist_offers SET cascaded = true WHERE id = ?").run(offer.id);
    effects.push(...issue(db, offer.event_id, timestamp));
  }
  return effects;
});

export const acceptOffer = (db: Db, offerId: number, userId: number, now: Date): { ok: true; effects: NotificationEffect[] } | { ok: false; reason: "spot_taken" } => transaction(db, () => {
  const offer = db.$client.query<OfferRow, [number]>("SELECT id, event_id, user_id, expires_at, message_id FROM waitlist_offers WHERE id = ? AND status = 'pending'").get(offerId);
  if (!offer || offer.user_id !== userId) return { ok: false, reason: "spot_taken" };
  const current = event(db, offer.event_id);
  if (!current || (current.capacity !== null && confirmed(db, current.id) >= current.capacity)) {
    db.$client.query("UPDATE waitlist_offers SET status = 'superseded' WHERE id = ?").run(offerId);
    return { ok: false, reason: "spot_taken" };
  }
  const timestamp = seconds(now);
  db.$client.query("UPDATE registrations SET status = 'registered', updated_at = ?, checked_in_at = NULL WHERE event_id = ? AND user_id = ?").run(timestamp, current.id, userId);
  db.$client.query("UPDATE waitlist_offers SET status = 'accepted' WHERE id = ?").run(offerId);
  const effects: NotificationEffect[] = current.capacity !== null && confirmed(db, current.id) >= current.capacity ? supersede(db, current.id, offerId) : [];
  return { ok: true, effects };
});

export const setCapacity = (db: Db, eventId: number, capacity: number | null, now: Date) => transaction(db, () => {
  const before = event(db, eventId)?.capacity;
  db.$client.query("UPDATE events SET capacity = ?, updated_at = ? WHERE id = ?").run(capacity, seconds(now), eventId);
  const increased = before !== undefined && ((capacity === null && before !== null) || (capacity !== null && before !== null && capacity > before));
  return increased ? issue(db, eventId, seconds(now)) : [];
});

export const cancelEvent = (db: Db, eventId: number): { userIds: number[]; effects: SupersededEffect[] } => transaction(db, () => {
  const participants = db.$client.query<{ user_id: number }, [number]>("SELECT user_id FROM registrations WHERE event_id = ? AND status IN ('registered', 'checked_in', 'waitlisted')").all(eventId);
  db.$client.query("UPDATE events SET status = 'canceled' WHERE id = ?").run(eventId);
  return { userIds: [...new Set(participants.map((row) => row.user_id))], effects: supersede(db, eventId) };
});
