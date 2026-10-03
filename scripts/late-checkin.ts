// Checks someone in to an event that is already over: they ran, but never made
// it onto the roster. To keep the headcount honest, a random no-show — someone
// still "registered" who never checked in — gives up their spot to them.
//
// Preview (default):
//   docker compose exec -T app bun run scripts/late-checkin.ts <event-id> <user-id|@username>
// Apply:
//   docker compose exec -T app bun run scripts/late-checkin.ts <event-id> <user-id|@username> --apply
//
// Someone already "registered" is simply checked in, with nobody swapped out.
// No-shows holding a paid ticket are never picked: canceling them would strand
// their order. A ticketed event refuses without --comp, as in add-event-person.ts.
//
// Afterwards the person is invited into every chat tied to the event (its home
// chat and any chats gating it) that Telegram says they are not in yet. Unlike the
// sweeper's invite, this is no trial: they attended, so the chat is theirs to keep.
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
  console.error("Usage: bun run scripts/late-checkin.ts <event-id> <user-id|@username> [--apply] [--comp]");
  process.exit(1);
}

const botToken = process.env.BOT_TOKEN ?? "";
const db = new Database(process.env.DATABASE_PATH ?? "./data/sku.db");
db.exec("PRAGMA foreign_keys = ON");

type EventRow = { id: number; title: string; status: string; starts_at: number; ended_at: number | null; home_chat_id: number | null };
type UserRow = { id: number; name: string; username: string | null; locale: string; is_banned: number };
type RegistrationRow = { id: number; status: string; is_staff: number };
type NoShowRow = { registration_id: number; user_id: number; name: string; username: string | null };
type ChatRow = { chat_id: number; title: string | null };

const moscow = (value: number) => new Date(value * 1000)
  .toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });
const label = (name: string, username: string | null) => `${name}${username ? ` (@${username})` : ""}`;

/** Registered but never checked in, and safe to cancel: no live paid ticket behind the spot. */
const noShows = (excludeUserId: number) => db.query<NoShowRow, [number, number]>(`
  SELECT r.id AS registration_id, r.user_id, u.first_name || COALESCE(' ' || u.last_name, '') AS name, u.username
  FROM registrations r
  JOIN users u ON u.id = r.user_id
  WHERE r.event_id = ?1 AND r.status = 'registered' AND r.is_staff = 0 AND r.user_id <> ?2
    AND NOT EXISTS (
      SELECT 1 FROM ticket_orders o
      WHERE o.event_id = r.event_id AND o.user_id = r.user_id AND o.ticket_tier_id IS NOT NULL
        AND o.status NOT IN ('refunded', 'canceled')
    )
  ORDER BY r.id
`).all(eventId, excludeUserId);

type TelegramResult<T> = { ok: true; result: T } | { ok: false; description: string };
/** Never throws: a network failure after the check-in commits must not hide which invites went out. */
const telegram = async <T>(method: string, body: Record<string, unknown>): Promise<TelegramResult<T>> => {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return await response.json() as TelegramResult<T>;
  } catch (error) {
    return { ok: false, description: error instanceof Error ? error.message : String(error) };
  }
};

/** True or false when Telegram gives a plain answer, the reason when it does not. */
const isMember = async (chatId: number, userId: number): Promise<boolean | string> => {
  const answer = await telegram<{ status: string; is_member?: boolean }>("getChatMember", { chat_id: chatId, user_id: userId });
  if (!answer.ok) return answer.description;
  const member = answer.result.status === "restricted"
    ? answer.result.is_member === true
    : ["creator", "administrator", "member"].includes(answer.result.status);
  db.query(`
    INSERT INTO chat_members (chat_id, user_id, is_member, checked_at) VALUES (?, ?, ?, unixepoch())
    ON CONFLICT (chat_id, user_id) DO UPDATE SET is_member = excluded.is_member, checked_at = excluded.checked_at
  `).run(chatId, userId, member ? 1 : 0);
  return member;
};

const inviteText = (locale: string, title: string) => locale === "en"
  ? `<b>Thanks for running with us</b>\n\n${title}\n\nHere is your way into the chat. The link is single-use and yours alone.`
  : `<b>Спасибо, что пробежал с нами</b>\n\n${title}\n\nВот твой вход в чат. Ссылка одноразовая и только для тебя.`;

/** A single-use link, DMed to them. The link is revoked again if the message cannot be delivered. */
const invite = async (chat: ChatRow, user: UserRow, event: EventRow): Promise<string> => {
  const link = await telegram<{ invite_link: string }>("createChatInviteLink", {
    chat_id: chat.chat_id,
    name: `sku late evt ${event.id} u${user.id}`.slice(0, 32),
    expire_date: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    member_limit: 1,
  });
  if (!link.ok) return `could not create a link: ${link.description}`;

  const sent = await telegram("sendMessage", {
    chat_id: user.id,
    text: inviteText(user.locale, event.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: user.locale === "en" ? "💬 Join the chat" : "💬 Войти в чат", url: link.result.invite_link }]] },
  });
  if (!sent.ok) {
    await telegram("revokeChatInviteLink", { chat_id: chat.chat_id, invite_link: link.result.invite_link });
    return `could not message them (${sent.description}); the link was revoked`;
  }

  // Recorded as already kept: the sweeper must never treat them as a guest on trial.
  db.query(`
    INSERT INTO chat_guests (chat_id, user_id, event_id, invite_link, status, created_at, settled_at)
    VALUES (?1, ?2, ?3, ?4, 'kept', unixepoch(), unixepoch())
    ON CONFLICT (chat_id, user_id) DO UPDATE
      SET event_id = excluded.event_id, invite_link = excluded.invite_link,
          status = 'kept', created_at = excluded.created_at, settled_at = excluded.settled_at
  `).run(chat.chat_id, user.id, event.id, link.result.invite_link);
  return "invite sent";
};

try {
  const event = db.query<EventRow, [number]>(
    "SELECT id, title, status, starts_at, ended_at, home_chat_id FROM events WHERE id = ?",
  ).get(eventId);
  if (!event) throw new Error(`No event ${eventId}.`);

  const handle = person.replace(/^@/, "");
  const userColumns = "id, first_name || COALESCE(' ' || last_name, '') AS name, username, locale, is_banned";
  const user = /^\d+$/.test(person)
    ? db.query<UserRow, [number]>(`SELECT ${userColumns} FROM users WHERE id = ?`).get(Number(person))
    : db.query<UserRow, [string]>(`SELECT ${userColumns} FROM users WHERE username = ? COLLATE NOCASE`).get(handle);
  if (!user) {
    throw new Error(/^\d+$/.test(person)
      ? `No user ${person}. They have to open the bot once — /start — before they can be checked in.`
      : `No user @${handle}. Find their numeric id and pass that instead.`);
  }

  console.log(`\nEvent ${event.id} — ${event.title}`);
  console.log(`  status:  ${event.status}${event.ended_at === null ? "" : ` (ended ${moscow(event.ended_at)})`}`);
  console.log(`  starts:  ${moscow(event.starts_at)} MSK`);
  console.log(`\nPerson ${user.id} — ${label(user.name, user.username)}\n`);

  if (event.ended_at === null) throw new Error(`Event ${eventId} has not been ended. Check them in from the app instead.`);
  if (user.is_banned) throw new Error(`User ${user.id} is banned. Lift the ban first.`);

  const registration = db.query<RegistrationRow, [number, number]>(
    "SELECT id, status, is_staff FROM registrations WHERE event_id = ? AND user_id = ?",
  ).get(eventId, user.id);
  if (registration?.status === "checked_in") throw new Error(`User ${user.id} is already checked in. Nothing to do.`);

  const needsSwap = registration?.status !== "registered";
  const tiers = db.query<{ count: number }, [number]>("SELECT count(*) AS count FROM ticket_tiers WHERE event_id = ?").get(eventId)?.count ?? 0;
  if (needsSwap && tiers > 0 && !comp) {
    throw new Error(`Event ${eventId} sells tickets, and this command creates no order or payment.`
      + " Pass --comp if a free spot is what you mean.");
  }

  const pool = needsSwap ? noShows(user.id) : [];
  if (needsSwap && pool.length === 0) throw new Error(`Event ${eventId} has no no-show without a paid ticket to replace. Nothing was changed.`);

  console.log(needsSwap
    ? `They are ${registration ? `"${registration.status}"` : "not on the roster"}. One of these ${pool.length} no-show(s) would be canceled at random:`
    : "They are \"registered\", so they would simply be checked in.");
  for (const row of pool) console.log(`  ${row.user_id} — ${label(row.name, row.username)}`);

  const chats = db.query<ChatRow, [number | null, number]>(`
    SELECT ids.chat_id, c.title FROM (
      SELECT ?1 AS chat_id WHERE ?1 IS NOT NULL
      UNION SELECT chat_id FROM event_chats WHERE event_id = ?2
    ) ids
    LEFT JOIN chats c ON c.id = ids.chat_id
    ORDER BY ids.chat_id
  `).all(event.home_chat_id, eventId);

  // Telegram is asked even in preview: getChatMember changes nothing but the cache.
  const outside: ChatRow[] = [];
  if (chats.length > 0) {
    console.log(`\nChats tied to this event${botToken ? "" : " (BOT_TOKEN is not set, so membership cannot be checked)"}:`);
    for (const chat of chats) {
      const member = botToken ? await isMember(chat.chat_id, user.id) : "unknown";
      if (member === false) outside.push(chat);
      console.log(`  ${chat.title ?? chat.chat_id}: ${member === true ? "member" : member === false ? "not a member — would be invited" : `lookup failed (${member})`}`);
    }
  }

  if (!apply) {
    console.log("\nPreview only. Run the same command with --apply to check them in.");
  } else {
    const checkIn = db.transaction(() => {
      // Re-read under the write transaction so the roster cannot shift underneath us.
      const current = db.query<RegistrationRow, [number, number]>(
        "SELECT id, status, is_staff FROM registrations WHERE event_id = ? AND user_id = ?",
      ).get(eventId, user.id);
      if (current?.status !== registration?.status) throw new Error("Their registration changed while this command was running; nothing was changed.");

      const timestamp = Math.floor(Date.now() / 1000);
      let replaced: NoShowRow | null = null;
      if (needsSwap) {
        const candidates = noShows(user.id);
        replaced = candidates[Math.floor(Math.random() * candidates.length)] ?? null;
        if (!replaced) throw new Error("The no-shows changed while this command was running; nothing was changed.");
        db.query("UPDATE registrations SET status = 'canceled', checked_in_at = NULL, updated_at = ? WHERE id = ?")
          .run(timestamp, replaced.registration_id);
      }

      // Dated to the start of the event, so it sits alongside everyone checked in at the door.
      if (current) {
        db.query("UPDATE registrations SET status = 'checked_in', checked_in_at = ?, updated_at = ? WHERE id = ?")
          .run(event.starts_at, timestamp, current.id);
      } else {
        db.query("INSERT INTO registrations (event_id, user_id, status, created_at, updated_at, checked_in_at) VALUES (?, ?, 'checked_in', ?, ?, ?)")
          .run(eventId, user.id, timestamp, timestamp, event.starts_at);
      }
      return replaced;
    });

    const replaced = checkIn.immediate();
    console.log(`\nChecked in user ${user.id} to event ${eventId}.`);
    if (replaced) console.log(`Canceled no-show ${replaced.user_id} — ${label(replaced.name, replaced.username)}.`);
    if (tiers > 0 && needsSwap) console.log("Comped: no order, payment, or receipt exists for this spot.");

    for (const chat of outside) console.log(`  ${chat.title ?? chat.chat_id}: ${await invite(chat, user, event)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.close();
}
