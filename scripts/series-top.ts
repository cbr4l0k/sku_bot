// Lists the top participants of every series, or of one series, ranked by check-ins.
//
//   docker compose exec -T app bun run scripts/series-top.ts [series-id] [--limit N]
//
// Read-only. Ranks people the way the series screen ranks its regulars: by
// check-ins, staff included, so an admin who turned up is counted like anyone.
import { Database } from "bun:sqlite";

const usage = "Usage: bun run scripts/series-top.ts [series-id] [--limit N]";
const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt === -1 ? 10 : Number(args[limitAt + 1]);
const rest = limitAt === -1 ? args : args.filter((_, index) => index !== limitAt && index !== limitAt + 1);
const seriesId = rest[0] === undefined ? null : Number(rest[0]);
if (
  rest.length > 1
  || !Number.isSafeInteger(limit) || limit <= 0
  || (seriesId !== null && (!Number.isSafeInteger(seriesId) || seriesId <= 0))
) {
  console.error(usage);
  process.exit(1);
}

const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db", { readonly: true });

type SeriesRow = { id: number; city: string; title: string; occurrences: number };
type ParticipantRow = {
  user_id: number;
  name: string;
  username: string | null;
  checked_in: number;
  confirmed: number;
  staff: string;
};

try {
  const series = db.query<SeriesRow, [number | null, number | null]>(`
    SELECT s.id, s.city, s.title, (SELECT count(*) FROM events e WHERE e.series_id = s.id) AS occurrences
    FROM event_series s
    WHERE ? IS NULL OR s.id = ?
    ORDER BY s.id
  `).all(seriesId, seriesId);
  if (seriesId !== null && !series.length) throw new Error(`No series ${seriesId}.`);
  if (!series.length) console.log("No series.");

  const top = db.query<ParticipantRow, [number, number]>(`
    SELECT
      r.user_id,
      u.first_name || COALESCE(' ' || u.last_name, '') AS name,
      u.username,
      sum(r.status = 'checked_in') AS checked_in,
      sum(r.status IN ('registered', 'checked_in')) AS confirmed,
      CASE WHEN max(r.is_staff) = 1 THEN 'yes' ELSE '' END AS staff
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    JOIN users u ON u.id = r.user_id
    WHERE e.series_id = ?
    GROUP BY r.user_id
    HAVING checked_in > 0
    ORDER BY checked_in DESC, r.user_id
    LIMIT ?
  `);

  for (const row of series) {
    console.log(`\nSeries ${row.id} — ${row.title} (${row.city}, ${row.occurrences} occurrence(s))`);
    const people = top.all(row.id, limit);
    if (people.length) console.table(people);
    else console.log("Nobody has checked in yet.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
