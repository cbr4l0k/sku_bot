import type { CitySlug } from "@sku/cities";
import type { Db } from "@sku/db";

/**
 * What is stuck until an admin does something about it — the top of their HQ.
 *
 * Each list is narrowed to the branches the admin runs. Branchless chats are a
 * club-wide matter: only a general admin may file them (see `PUT /admin/chats/:id`),
 * so only they are shown them, exactly as in `chatCatalog`.
 */

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

export const needsAttention = (db: Db, scope: readonly CitySlug[], includeUnassigned: boolean, now: Date) => {
  const unassignedChats = includeUnassigned
    ? db.$client.query<{ id: number; title: string | null; created_at: number }, []>(
      "SELECT id, title, created_at FROM chats WHERE city IS NULL ORDER BY created_at, id",
    ).all().map((row) => ({ id: row.id, title: row.title, createdAt: iso(row.created_at) }))
    : [];

  if (scope.length === 0) return { unassignedChats, seriesDrafts: [], failedRefunds: [] };
  const cities = [...scope];

  // A spawned run waits in draft for a person to look at it. One whose date has
  // already gone by can no longer be published usefully, so it stops nagging.
  const seriesDrafts = db.$client.query<{
    id: number; series_id: number; series_title: string; title: string; city: CitySlug; starts_at: number;
  }, (string | number)[]>(`
    SELECT e.id, e.series_id, s.title AS series_title, e.title, e.city, e.starts_at
    FROM events e JOIN event_series s ON s.id = e.series_id
    WHERE e.status = 'draft' AND e.ended_at IS NULL AND e.starts_at >= ?
      AND e.city IN (${placeholders(cities)})
    ORDER BY e.starts_at, e.id
  `).all(Math.floor(now.getTime() / 1000), ...cities).map((row) => ({
    eventId: row.id,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    title: row.title,
    city: row.city,
    startsAt: iso(row.starts_at),
  }));

  // The provider's own words come from the latest refund row, which is where both
  // a canceled refund and a definitive rejection record why.
  const failedRefunds = db.$client.query<{
    id: string; event_id: number; event_title: string; city: CitySlug; amount_minor: number; currency: string;
    user_id: number; first_name: string; last_name: string | null; username: string | null;
    failure_reason: string | null; failed_at: number;
  }, string[]>(`
    SELECT o.id, o.event_id, e.title AS event_title, e.city, o.amount_minor, o.currency,
      u.id AS user_id, u.first_name, u.last_name, u.username,
      r.failure_reason, coalesce(r.updated_at, o.updated_at) AS failed_at
    FROM ticket_orders o
    JOIN events e ON e.id = o.event_id
    JOIN users u ON u.id = o.user_id
    LEFT JOIN refunds r ON r.id = (
      SELECT id FROM refunds WHERE order_id = o.id ORDER BY created_at DESC, rowid DESC LIMIT 1
    )
    WHERE o.status = 'refund_failed' AND e.city IN (${placeholders(cities)})
    ORDER BY failed_at DESC, o.id
  `).all(...cities).map((row) => ({
    orderId: row.id,
    eventId: row.event_id,
    eventTitle: row.event_title,
    city: row.city,
    amountMinor: row.amount_minor,
    currency: row.currency,
    failureReason: row.failure_reason,
    failedAt: iso(row.failed_at),
    buyer: { userId: row.user_id, firstName: row.first_name, lastName: row.last_name, username: row.username },
  }));

  return { unassignedChats, seriesDrafts, failedRefunds };
};
