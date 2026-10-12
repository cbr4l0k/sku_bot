import { Effect } from "effect";
import type { Db } from "@sku/db";
import { Database } from "../services";
import type { DraftReviewEffect, RefundAlertEffect } from "./types";

/** General admins. Env-configured ones are lifted into `is_admin` at boot and on first contact. */
const generalAdminIds = (db: Db): number[] => db.$client
  .query<{ id: number }, []>("SELECT id FROM users WHERE is_admin = 1 ORDER BY id").all().map((row) => row.id);

const branchAdminIds = (db: Db, city: string): number[] => db.$client
  .query<{ user_id: number }, [string]>("SELECT user_id FROM user_city_roles WHERE city = ? AND role = 'admin' ORDER BY user_id")
  .all(city).map((row) => row.user_id);

/**
 * A draft the series raised on its own waits for a person. Its leads hear about it,
 * and so does whoever may publish it: the branch's admins, or the club's when the
 * branch has none. Only those who may publish are handed the buttons.
 */
export const draftReviewEffects = Effect.fnUntraced(function* (eventId: number): Effect.fn.Return<DraftReviewEffect[], never, Database> {
  const db = yield* Database;
  const event = db.$client.query<{ city: string }, [number]>("SELECT city FROM events WHERE id = ? AND status = 'draft'").get(eventId);
  if (!event) return [];
  const leads = db.$client.query<{ user_id: number }, [number]>("SELECT user_id FROM event_organizers WHERE event_id = ? ORDER BY user_id")
    .all(eventId).map((row) => row.user_id);
  const branch = branchAdminIds(db, event.city);
  const general = generalAdminIds(db);
  const publishers = new Set([...general, ...branch]);
  const recipients = new Set([...leads, ...(branch.length ? branch : general)]);
  return [...recipients].map((userId) => ({ kind: "draft_review", userId, eventId, canPublish: publishers.has(userId) }));
});

/** A refund that failed holds a runner's money and place; the people who can retry it are told. */
export const refundAlertEffects = (db: Db, order: { id: string; event_id: number; user_id: number }, reason: string | null): RefundAlertEffect[] => {
  const city = db.$client.query<{ city: string }, [number]>("SELECT city FROM events WHERE id = ?").get(order.event_id)?.city;
  const recipients = new Set([...generalAdminIds(db), ...(city ? branchAdminIds(db, city) : [])]);
  return [...recipients].map((userId) => ({ kind: "refund_failed_alert", userId, eventId: order.event_id, orderId: order.id, runnerId: order.user_id, reason }));
};
