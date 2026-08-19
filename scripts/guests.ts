// Explains, for one event, who is getting a chat invite and who is not.
//
//   docker compose exec -T app bun run scripts/guests.ts 4
//
// Read-only. Answers the question "why has this person not been invited?" without
// needing the Telegram side: everything printed is what the bot itself goes on.
import { Database } from "bun:sqlite";

const eventId = Number(process.argv[2]);
if (!Number.isSafeInteger(eventId) || eventId <= 0) {
  console.error("Usage: bun run scripts/guests.ts <event-id>");
  process.exit(1);
}

const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db", { readonly: true });

type EventRow = { id: number; title: string; status: string; ended_at: number | null; home_chat_id: number | null };
const event = db.query<EventRow, [number]>("SELECT id, title, status, ended_at, home_chat_id FROM events WHERE id = ?").get(eventId);

if (!event) {
  console.error(`No event ${eventId}.`);
  process.exit(1);
}

const when = (value: number | null) => (value === null ? "—" : new Date(value * 1000).toISOString().replace("T", " ").slice(0, 16));

console.log(`\nEvent ${event.id} — ${event.title}`);
console.log(`  status:      ${event.status}`);
console.log(`  ended:       ${when(event.ended_at)}`);
console.log(`  event chat:  ${event.home_chat_id ?? "NOT SET — nobody will ever be invited"}\n`);

type Row = {
  user_id: number;
  name: string;
  username: string | null;
  status: string;
  banned: number;
  cached_member: number | null;
  cached_at: number | null;
  trial: string | null;
  trial_event: number | null;
};

const rows = db.query<Row, [number | null, number]>(`
  SELECT r.user_id, u.first_name || COALESCE(' ' || u.last_name, '') AS name, u.username,
         r.status, u.is_banned AS banned,
         m.is_member AS cached_member, m.checked_at AS cached_at,
         g.status AS trial, g.event_id AS trial_event
  FROM registrations r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN chat_members m ON m.user_id = r.user_id AND m.chat_id = ?1
  LEFT JOIN chat_guests  g ON g.user_id = r.user_id AND g.chat_id = ?1
  WHERE r.event_id = ?2
  ORDER BY r.created_at, r.id
`).all(event.home_chat_id, event.id);

/** Mirrors inviteCandidates() in apps/server/src/core/guests.ts. */
const verdict = (row: Row): string => {
  if (event.home_chat_id === null) return "no event chat set";
  if (row.status === "canceled") return "canceled their spot";
  if (row.status === "waitlisted") return "in the queue — no spot yet";
  if (row.banned) return "banned";
  if (row.trial === "invited") return `on trial (via event ${row.trial_event})`;
  if (row.trial === "kept") return "guest who showed up — now a member";
  if (event.status !== "published") return `event is ${event.status}`;
  if (event.ended_at !== null) return "event has ended";
  if (row.cached_member === 1) return "already in the chat";
  return "AWAITING INVITE — next sweep should send it";
};

/** The cached answer's age, so a stale "yes" is visible rather than mistaken for fact. */
const age = (row: Row): string => {
  if (row.cached_at === null) return "";
  const minutes = Math.floor((Date.now() / 1000 - row.cached_at) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

const pad = (value: string, width: number) => value.padEnd(width).slice(0, width);
console.log(`${pad("user id", 12)} ${pad("name", 20)} ${pad("reg", 12)} ${pad("in chat?", 9)} ${pad("asked", 10)} why`);
console.log("-".repeat(108));
for (const row of rows) {
  const inChat = row.cached_member === null ? "unknown" : row.cached_member === 1 ? "yes" : "no";
  console.log(`${pad(String(row.user_id), 12)} ${pad(row.name, 20)} ${pad(row.status, 12)} ${pad(inChat, 9)} ${pad(age(row), 10)} ${verdict(row)}`);
}

const waiting = rows.filter((row) => verdict(row).startsWith("AWAITING")).length;
const onTrial = rows.filter((row) => row.trial === "invited").length;
console.log(`\n${rows.length} registered · ${onTrial} on trial · ${waiting} awaiting invite`);
console.log('"in chat?" is the bot\'s cached answer, last asked when "asked" says — it is re-checked');
console.log("after 5 minutes, so a recent join or exit can take that long to show up here.\n");
