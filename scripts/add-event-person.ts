// Puts one person on an event's roster when they cannot do it themselves: no
// signal at the door, a Telegram outage, a Mini App that will not load.
//
// Preview (default):
//   docker compose exec -T app bun run scripts/add-event-person.ts <event-id> <user-id|@username>
// Apply:
//   docker compose exec -T app bun run scripts/add-event-person.ts <event-id> <user-id|@username> --apply
//
// The outcome mirrors the Join button (apps/server/src/core/registration.ts): a
// spot while the event has room, the tail of the queue once it is full. Two of
// its rules are treated differently on purpose, because whoever runs this
// command is the authority those rules exist to protect:
//
//   - a chat-restricted event is reported rather than refused. The cached
//     Telegram membership is printed as a warning and the person goes on anyway.
//   - an event selling tickets refuses without --comp, because a registration
//     with no order behind it gives a paid spot away for free.
import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith("--"));
const positional = args.filter((argument) => !argument.startsWith("--"));
const unknown = flags.filter((flag) => flag !== "--apply" && flag !== "--comp");
const apply = flags.includes("--apply");
const comp = flags.includes("--comp");

const eventId = Number(positional[0]);
const person = positional[1] ?? "";

if (!Number.isSafeInteger(eventId) || eventId <= 0 || person === "" || unknown.length > 0) {
  if (unknown.length > 0) console.error(`Unknown option: ${unknown.join(" ")}`);
  console.error("Usage: bun run scripts/add-event-person.ts <event-id> <user-id|@username> [--apply] [--comp]");
  process.exit(1);
}

const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db");
db.exec("PRAGMA foreign_keys = ON");

type EventRow = {
  id: number;
  title: string;
  city: string;
  status: string;
  starts_at: number;
  ended_at: number | null;
  capacity: number | null;
  waitlist_enabled: number;
};
type UserRow = { id: number; name: string; username: string | null; is_banned: number };
type RegistrationRow = { id: number; status: string; is_staff: number };
type ChatRow = { chat_id: number; title: string | null; is_member: number | null; checked_at: number | null };

const moscow = (value: number) => new Date(value * 1000)
  .toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });

/** Spots actually taken: staff sit on the roster without holding one. */
const confirmedCount = () => db.query<{ count: number }, [number]>(`
  SELECT count(*) AS count FROM registrations
  WHERE event_id = ? AND status IN ('registered', 'checked_in') AND is_staff = 0
`).get(eventId)?.count ?? 0;

/** A live offer is a spot already promised to someone in the queue. */
const reservedCount = (at: number) => db.query<{ count: number }, [number, number]>(`
  SELECT count(*) AS count FROM waitlist_offers
  WHERE event_id = ? AND status = 'pending' AND expires_at > ?
`).get(eventId, at)?.count ?? 0;

const queuePosition = (userId: number) => db
  .query<{ user_id: number }, [number]>(`
    SELECT user_id FROM registrations
    WHERE event_id = ? AND status = 'waitlisted'
    ORDER BY created_at, id
  `)
  .all(eventId)
  .findIndex((row) => row.user_id === userId) + 1;

try {
  const event = db.query<EventRow, [number]>(`
    SELECT id, title, city, status, starts_at, ended_at, capacity, waitlist_enabled
    FROM events WHERE id = ?
  `).get(eventId);
  if (!event) throw new Error(`No event ${eventId}.`);

  const handle = person.replace(/^@/, "");
  const user = /^\d+$/.test(person)
    ? db.query<UserRow, [number]>(`
        SELECT id, first_name || COALESCE(' ' || last_name, '') AS name, username, is_banned
        FROM users WHERE id = ?
      `).get(Number(person))
    : db.query<UserRow, [string]>(`
        SELECT id, first_name || COALESCE(' ' || last_name, '') AS name, username, is_banned
        FROM users WHERE username = ? COLLATE NOCASE
      `).get(handle);
  if (!user) {
    throw new Error(/^\d+$/.test(person)
      ? `No user ${person}. They have to open the bot once — /start — before they can be put on a roster.`
      : `No user @${handle}. Look them up with event-people.ts on an event they have already joined, then pass the numeric id.`);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const confirmed = confirmedCount();
  const reserved = reservedCount(timestamp);
  const waiting = db.query<{ count: number }, [number]>(
    "SELECT count(*) AS count FROM registrations WHERE event_id = ? AND status = 'waitlisted'",
  ).get(eventId)?.count ?? 0;

  console.log(`\nEvent ${event.id} — ${event.title}`);
  console.log(`  branch:    ${event.city}`);
  console.log(`  status:    ${event.status}${event.ended_at === null ? "" : ` (ended ${moscow(event.ended_at)})`}`);
  console.log(`  starts:    ${moscow(event.starts_at)} MSK`);
  console.log(`  spots:     ${confirmed}${event.capacity === null ? " taken of unlimited" : ` taken of ${event.capacity}`}`
    + `${reserved > 0 ? `, ${reserved} held by live queue offers` : ""}`);
  console.log(`  queue:     ${event.waitlist_enabled ? `on, ${waiting} waiting` : "off"}`);
  console.log(`\nPerson ${user.id} — ${user.name}${user.username ? ` (@${user.username})` : ""}\n`);

  if (event.status !== "published") throw new Error(`Event ${eventId} is ${event.status}, so nobody can be on its roster. Publish it first.`);
  if (event.ended_at !== null) throw new Error(`Event ${eventId} was ended on ${moscow(event.ended_at)} MSK. Reopen it in the app first.`);
  if (user.is_banned) throw new Error(`User ${user.id} is banned. Lift the ban before putting them on a roster.`);

  const registration = db.query<RegistrationRow, [number, number]>(
    "SELECT id, status, is_staff FROM registrations WHERE event_id = ? AND user_id = ?",
  ).get(eventId, user.id);
  if (registration && registration.status !== "canceled") {
    throw new Error(`User ${user.id} is already on this event as "${registration.status}"`
      + `${registration.is_staff ? " (staff)" : ""}. Nothing to do.`);
  }

  // A restricted event admits only members of its chats. This is the operator's
  // call to make, so it is a warning: the cache can easily say "not a member"
  // about someone who simply has not opened the app since joining the chat.
  const chats = db.query<ChatRow, [number, number]>(`
    SELECT ec.chat_id, c.title, m.is_member, m.checked_at
    FROM event_chats ec
    LEFT JOIN chats c ON c.id = ec.chat_id
    LEFT JOIN chat_members m ON m.chat_id = ec.chat_id AND m.user_id = ?
    WHERE ec.event_id = ?
    ORDER BY ec.chat_id
  `).all(user.id, eventId);
  if (chats.length > 0) {
    const member = chats.some((chat) => chat.is_member === 1);
    console.log(`This event is restricted to ${chats.length} chat(s). Telegram membership, as last cached:`);
    for (const chat of chats) {
      const cached = chat.is_member === null ? "never checked" : `${chat.is_member ? "member" : "not a member"}, checked ${moscow(chat.checked_at ?? 0)} MSK`;
      console.log(`  ${chat.title ?? chat.chat_id}: ${cached}`);
    }
    console.log(member
      ? "The app would let them join on its own.\n"
      : "WARNING: the app would turn them away. Adding them here overrides that.\n");
  }

  const tiers = db.query<{ count: number }, [number]>("SELECT count(*) AS count FROM ticket_tiers WHERE event_id = ?").get(eventId)?.count ?? 0;
  if (tiers > 0 && !comp) {
    throw new Error(`Event ${eventId} sells tickets, and this command creates no order or payment.`
      + " Adding them here is a free spot. Pass --comp if that is what you mean.");
  }

  const hasRoom = event.capacity === null || event.capacity - confirmed - reserved > 0;
  if (!hasRoom && !event.waitlist_enabled) {
    throw new Error(`Event ${eventId} is full and its queue is off, so there is nowhere to put anyone.`
      + " Raise the capacity or turn the queue on in the app first.");
  }
  const status = hasRoom ? "registered" : "waitlisted";

  if (!apply) {
    if (tiers > 0) console.log("Comping a ticketed event: no order and no payment will be recorded.\n");
    console.log(`Preview only: user ${user.id} would be added as "${status}"`
      + `${status === "waitlisted" ? ` at the back of the queue, position ${waiting + 1}` : ""}.`);
    if (registration) console.log("Their earlier canceled registration would be reused, taking a fresh queue timestamp.");
    console.log("Run the same command with --apply to add them.");
  } else {
    const add = db.transaction(() => {
      // Re-read under the write transaction so a join landing between the
      // preview and the insert cannot hand out a spot twice.
      const current = db.query<RegistrationRow, [number, number]>(
        "SELECT id, status, is_staff FROM registrations WHERE event_id = ? AND user_id = ?",
      ).get(eventId, user.id);
      if (current && current.status !== "canceled") throw new Error("They joined while this command was running; nothing was changed.");
      const room = event.capacity === null || event.capacity - confirmedCount() - reservedCount(timestamp) > 0;
      if (room !== hasRoom) throw new Error("The event filled up while this command was running; nothing was changed. Run it again.");

      if (current) {
        db.query("UPDATE registrations SET status = ?, created_at = ?, updated_at = ?, checked_in_at = NULL WHERE id = ?")
          .run(status, timestamp, timestamp, current.id);
      } else {
        db.query("INSERT INTO registrations (event_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(eventId, user.id, status, timestamp, timestamp);
      }
      return status === "waitlisted" ? { status, position: queuePosition(user.id) } : { status };
    });

    const result = add.immediate();
    console.log(`Added user ${user.id} to event ${eventId} as "${result.status}"`
      + `${"position" in result ? `, queue position ${result.position}` : ""}.`);
    if ("position" in result) console.log("To move them up the queue: bun run scripts/move-queue-user.ts <event-id> <user-id> <position>");
    if (tiers > 0) console.log("Comped: no order, payment, or receipt exists for this spot.");
    console.log("The bot does not tell them — send them the good news yourself.");
    console.log("An event-chat invite, if the event has one, follows within a minute.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
