// Groups copied historical events into series without touching attendance or sales data.
//
// Preview (default):
//   docker compose exec -T app bun run scripts/backfill-series.ts
// Apply (inserts series templates and links their historical events):
//   docker compose exec -T app bun run scripts/backfill-series.ts --apply
import { Database } from "bun:sqlite";

const apply = process.argv.slice(2).includes("--apply");
const databasePath = process.env.DATABASE_PATH ?? "./data/sku.db";
const db = apply ? new Database(databasePath) : new Database(databasePath, { readonly: true });
db.exec("PRAGMA foreign_keys = ON");

const DAY_SECONDS = 24 * 60 * 60;
const TIMEZONE = "Europe/Moscow";
const quoteCharacters = /[«»"„“”'’`]/gu;
const embeddedDate = /\d{1,2}\s*[./]\s*\d{1,2}(?:\s*[./]\s*\d{2,4})?[./]?/gu;
const separators = /[^\p{L}\p{N}]+/gu;

type EventRow = {
  id: number;
  city: string;
  title: string;
  description: string;
  starts_at: number;
  location: string;
  location_url: string | null;
  capacity: number | null;
  waitlist_enabled: number;
  home_chat_id: number | null;
  created_by: number;
};

type ProductRow = {
  id: number;
  kind: string;
  name: string;
  description: string | null;
  price_minor: number;
  stock: number | null;
  max_per_order: number;
  active: number;
  sort_order: number;
};

type VariantRow = {
  product_id: number;
  name: string;
  stock: number | null;
  active: number;
  sort_order: number;
};

type TemplateCounts = {
  ticket_tiers: number;
  products: number;
  variants: number;
  chats: number;
  organizers: number;
};

type ProposedSeries = {
  events: EventRow[];
  latest: EventRow;
  gaps: number[];
  cadenceDays: number | null;
  nextStartsAt: number | null;
  templateCounts: TemplateCounts;
};

const dateTimeFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const weekdayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  weekday: "short",
});

const normalize = (value: string): string => value
  .toLocaleLowerCase("ru-RU")
  .replace(quoteCharacters, "")
  .replace(embeddedDate, " ")
  .replace(separators, " ")
  .trim();

const keyFor = (event: EventRow): string => JSON.stringify([
  event.city,
  normalize(event.title),
  normalize(event.location),
]);

const moscowDateParts = (seconds: number): { year: number; month: number; day: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(seconds * 1000));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
};

const calendarDay = (seconds: number): number => {
  const { year, month, day } = moscowDateParts(seconds);
  return Math.floor(Date.UTC(year, month - 1, day) / (DAY_SECONDS * 1000));
};

const formatWhen = (seconds: number): string => {
  const date = new Date(seconds * 1000);
  return `${dateTimeFormat.format(date)} MSK (${weekdayFormat.format(date)})`;
};

const templateCounts = (eventId: number): TemplateCounts => {
  const counts = db.query<TemplateCounts, [number]>(`
    SELECT
      (SELECT count(*) FROM ticket_tiers WHERE event_id = ?1 AND active = 1) AS ticket_tiers,
      (SELECT count(*) FROM event_products WHERE event_id = ?1 AND active = 1) AS products,
      (SELECT count(*) FROM event_product_variants v
        JOIN event_products p ON p.id = v.product_id
        WHERE p.event_id = ?1 AND p.active = 1) AS variants,
      (SELECT count(*) FROM event_chats WHERE event_id = ?1) AS chats,
      (SELECT count(*) FROM event_organizers WHERE event_id = ?1) AS organizers
  `).get(eventId);
  if (!counts) throw new Error(`Could not count template rows for event ${eventId}.`);
  return counts;
};

const proposals = (): { series: ProposedSeries[]; oneOffs: number } => {
  const events = db.query<EventRow, []>(`
    SELECT id, city, title, description, starts_at, location, location_url,
      capacity, waitlist_enabled, home_chat_id, created_by
    FROM events
    WHERE series_id IS NULL
    ORDER BY starts_at, id
  `).all();
  const groups = new Map<string, EventRow[]>();
  for (const event of events) {
    const key = keyFor(event);
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }

  let oneOffs = 0;
  const series: ProposedSeries[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      oneOffs++;
      continue;
    }
    group.sort((left, right) => left.starts_at - right.starts_at || left.id - right.id);
    const latest = group[group.length - 1];
    if (!latest) throw new Error("A proposed series unexpectedly had no latest event.");
    const gaps = group.slice(1).map((event, index) =>
      calendarDay(event.starts_at) - calendarDay(group[index]?.starts_at ?? event.starts_at),
    );
    const firstGap = gaps[0];
    const cadenceDays = firstGap !== undefined && firstGap > 0 && gaps.every((gap) => gap === firstGap)
      ? firstGap
      : null;
    series.push({
      events: group,
      latest,
      gaps,
      cadenceDays,
      nextStartsAt: cadenceDays === null ? null : latest.starts_at + cadenceDays * DAY_SECONDS,
      templateCounts: templateCounts(latest.id),
    });
  }
  return { series, oneOffs };
};

const printProposal = (proposal: ProposedSeries, index: number): void => {
  console.log(`\nSeries ${index + 1}: ${proposal.latest.title}`);
  console.log(`City: ${proposal.latest.city}`);
  console.log(`Location: ${proposal.latest.location}`);
  console.log("Members:");
  for (const event of proposal.events) console.log(`  #${event.id} — ${formatWhen(event.starts_at)}`);
  if (proposal.cadenceDays === null) {
    console.log(`Cadence: IRREGULAR (calendar-day gaps: ${proposal.gaps.join(", ")})`);
    console.log("Next date: set by hand");
  } else {
    console.log(`Cadence: every ${proposal.cadenceDays} days (all calendar-day gaps: ${proposal.gaps.join(", ")})`);
    if (proposal.nextStartsAt === null) throw new Error("Regular series has no proposed next date.");
    console.log(`Next date: ${formatWhen(proposal.nextStartsAt)}`);
  }
  const counts = proposal.templateCounts;
  console.log(
    `Template rows: ${counts.ticket_tiers} ticket tiers, ${counts.products} products, `
    + `${counts.variants} product variants, ${counts.chats} chats, ${counts.organizers} organizers`,
  );
};

const insertSeries = (proposal: ProposedSeries, now: number): number => {
  const latest = proposal.latest;
  const inserted = db.query<{ id: number }, [string, string, string, string, string | null, number | null, number, number | null, number | null, number | null, number, number, number]>(`
    INSERT INTO event_series (
      city, title, description, location, location_url, capacity, waitlist_enabled,
      home_chat_id, next_starts_at, cadence_days, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    latest.city, latest.title, latest.description, latest.location, latest.location_url,
    latest.capacity, latest.waitlist_enabled, latest.home_chat_id, proposal.nextStartsAt,
    proposal.cadenceDays, latest.created_by, now, now,
  );
  if (!inserted) throw new Error(`Series insert for event ${latest.id} returned no id.`);

  db.query(`
    INSERT INTO series_ticket_tiers (
      series_id, name, price_minor, quota, active, sort_order, created_at, updated_at
    )
    SELECT ?, name, price_minor, quota, active, sort_order, ?, ?
    FROM ticket_tiers WHERE event_id = ? AND active = 1
    ORDER BY sort_order, id
  `).run(inserted.id, now, now, latest.id);

  const products = db.query<ProductRow, [number]>(`
    SELECT id, kind, name, description, price_minor, stock, max_per_order, active, sort_order
    FROM event_products WHERE event_id = ? AND active = 1
    ORDER BY sort_order, id
  `).all(latest.id);
  const productIds = new Map<number, number>();
  for (const product of products) {
    const copied = db.query<{ id: number }, [number, string, string, string | null, number, number | null, number, number, number, number, number]>(`
      INSERT INTO series_products (
        series_id, kind, name, description, price_minor, stock, max_per_order,
        active, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      inserted.id, product.kind, product.name, product.description, product.price_minor,
      product.stock, product.max_per_order, product.active, product.sort_order, now, now,
    );
    if (!copied) throw new Error(`Template product insert for event product ${product.id} returned no id.`);
    productIds.set(product.id, copied.id);
  }

  const variants = db.query<VariantRow, [number]>(`
    SELECT v.product_id, v.name, v.stock, v.active, v.sort_order
    FROM event_product_variants v
    JOIN event_products p ON p.id = v.product_id
    WHERE p.event_id = ? AND p.active = 1
    ORDER BY p.sort_order, p.id, v.sort_order, v.id
  `).all(latest.id);
  for (const variant of variants) {
    const productId = productIds.get(variant.product_id);
    if (productId === undefined) throw new Error(`Variant's event product ${variant.product_id} was not copied.`);
    db.query(`
      INSERT INTO series_product_variants (
        product_id, name, stock, active, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(productId, variant.name, variant.stock, variant.active, variant.sort_order, now, now);
  }

  db.query("INSERT INTO series_chats (series_id, chat_id) SELECT ?, chat_id FROM event_chats WHERE event_id = ?")
    .run(inserted.id, latest.id);
  db.query("INSERT INTO series_organizers (series_id, user_id) SELECT ?, user_id FROM event_organizers WHERE event_id = ?")
    .run(inserted.id, latest.id);

  for (const event of proposal.events) {
    const linked = db.query("UPDATE events SET series_id = ? WHERE id = ? AND series_id IS NULL")
      .run(inserted.id, event.id);
    if (linked.changes !== 1) throw new Error(`Event ${event.id} changed while the backfill was running; nothing was applied.`);
  }
  return inserted.id;
};

try {
  const preview = proposals();
  preview.series.forEach(printProposal);
  const eventCount = preview.series.reduce((total, proposal) => total + proposal.events.length, 0);
  console.log(`\nSummary: ${preview.series.length} series over ${eventCount} events, ${preview.oneOffs} events left as one-offs.`);

  if (!apply) {
    if (preview.series.length > 0) console.log("Preview only: run the same command with --apply to create and link these series.");
    else console.log("Preview only: nothing to backfill.");
  } else if (preview.series.length === 0) {
    console.log("Nothing to backfill.");
  } else {
    const write = db.transaction(() => {
      const current = proposals();
      const previewIds = preview.series.map((proposal) => proposal.events.map((event) => event.id));
      const currentIds = current.series.map((proposal) => proposal.events.map((event) => event.id));
      if (JSON.stringify(currentIds) !== JSON.stringify(previewIds)) {
        throw new Error("Eligible events changed after preview; nothing was applied.");
      }
      const now = Math.floor(Date.now() / 1000);
      for (const proposal of current.series) insertSeries(proposal, now);
    });
    write.immediate();
    console.log(`Applied: created ${preview.series.length} series and linked ${eventCount} events.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
