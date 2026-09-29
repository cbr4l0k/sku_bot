// Forgets the group chats the bot has been removed from. The bot files a chat the
// moment it joins one but never unfiles it, so admin screens keep offering groups
// it can no longer see into.
//
// Asks Telegram about the bot's own membership in every catalogued chat. A chat is
// only forgotten when Telegram clearly says the bot is out; a failed or ambiguous
// lookup keeps the chat and makes the command exit non-zero.
//
// A chat that is the only visibility gate of a live event or a series is never
// forgotten: dropping the gate would open that event to everyone. Re-gate or
// unrestrict it in the admin screen first, then run this again.
//
// Preview (default):
//   docker compose exec -T app bun run scripts/prune-chats.ts
// Apply:
//   docker compose exec -T app bun run scripts/prune-chats.ts --apply
import { Database } from "bun:sqlite";

/** What Telegram says about the bot in one chat. */
export type BotPresence =
  | { kind: "present" }
  | { kind: "gone"; reason: string }
  | { kind: "upgraded"; movedTo: number }
  | { kind: "unknown"; reason: string };

export type PresenceProbe = (chatId: number) => Promise<BotPresence>;

type TelegramReply<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string; parameters?: { migrate_to_chat_id?: number } };

type ChatMember = { status: string; is_member?: boolean };

const PRESENT = new Set(["creator", "administrator", "member"]);

/** Reads one getChatMember answer about the bot itself. Exported for tests. */
export const presenceOf = (reply: TelegramReply<ChatMember>): BotPresence => {
  if (reply.ok) {
    const { status, is_member: isMember } = reply.result;
    if (PRESENT.has(status) || (status === "restricted" && isMember === true)) return { kind: "present" };
    return { kind: "gone", reason: `bot status is "${status}"` };
  }
  const movedTo = reply.parameters?.migrate_to_chat_id;
  // The old id of an upgraded group: the bot carries it over itself on next use.
  if (movedTo !== undefined) return { kind: "upgraded", movedTo };
  // 403: kicked, not a member, or the group was deactivated.
  if (reply.error_code === 403) return { kind: "gone", reason: reply.description };
  // 400 "chat not found": the bot cannot see the chat at all any more.
  if (reply.error_code === 400 && /chat not found/i.test(reply.description)) {
    return { kind: "gone", reason: reply.description };
  }
  return { kind: "unknown", reason: `${reply.error_code} ${reply.description}` };
};

const telegramProbe = async (token: string): Promise<PresenceProbe> => {
  const call = async <T>(method: string, params: Record<string, number> = {}): Promise<TelegramReply<T>> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return (await response.json()) as TelegramReply<T>;
  };

  const me = await call<{ id: number; username?: string }>("getMe");
  if (!me.ok) throw new Error(`getMe failed: ${me.error_code} ${me.description}. Is BOT_TOKEN right?`);
  console.log(`Checking as @${me.result.username ?? me.result.id}`);

  return async (chatId) => {
    try {
      return presenceOf(await call<ChatMember>("getChatMember", { chat_id: chatId, user_id: me.result.id }));
    } catch (error) {
      return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
  };
};

type ChatRow = { id: number; city: string | null; title: string | null };
type Blocker = { kind: "event" | "series"; id: number; title: string };

/**
 * Live events and series for which `chatId` is the last gate. Ended and canceled
 * events keep their stale row instead: it is history, and removing it would make
 * them visible to everyone.
 */
const soleGateOf = (db: Database, chatId: number): Blocker[] => [
  ...db.query<Blocker, [number]>(`
    SELECT 'event' AS kind, e.id, e.title FROM event_chats ec
    JOIN events e ON e.id = ec.event_id
    WHERE ec.chat_id = ? AND e.ended_at IS NULL AND e.status <> 'canceled'
      AND NOT EXISTS (SELECT 1 FROM event_chats o WHERE o.event_id = ec.event_id AND o.chat_id <> ec.chat_id)
  `).all(chatId),
  ...db.query<Blocker, [number]>(`
    SELECT 'series' AS kind, s.id, s.title FROM series_chats sc
    JOIN event_series s ON s.id = sc.series_id
    WHERE sc.chat_id = ?
      AND NOT EXISTS (SELECT 1 FROM series_chats o WHERE o.series_id = sc.series_id AND o.chat_id <> sc.chat_id)
  `).all(chatId),
];

/** Removes the chat and every reference that is safe to drop, in one transaction. */
const forget = (db: Database, chatId: number): Record<string, number> => db.transaction(() => {
  // Checked again under the write lock so an admin edit since the preview cannot slip through.
  if (soleGateOf(db, chatId).length > 0) throw new Error(`Chat ${chatId} became the only gate of an event; skipped.`);
  const run = (sql: string) => db.query(sql).run(chatId).changes;
  return {
    eventGates: run(`
      DELETE FROM event_chats WHERE chat_id = ?1 AND event_id IN (
        SELECT event_id FROM event_chats WHERE chat_id <> ?1
      )`),
    seriesGates: run(`
      DELETE FROM series_chats WHERE chat_id = ?1 AND series_id IN (
        SELECT series_id FROM series_chats WHERE chat_id <> ?1
      )`),
    // Nobody can be invited into, or removed from, a chat the bot is not in.
    eventHomeChats: run("UPDATE events SET home_chat_id = NULL WHERE home_chat_id = ?"),
    seriesHomeChats: run("UPDATE event_series SET home_chat_id = NULL WHERE home_chat_id = ?"),
    guests: run("DELETE FROM chat_guests WHERE chat_id = ?"),
    cachedMemberships: run("DELETE FROM chat_members WHERE chat_id = ?"),
    chats: run("DELETE FROM chats WHERE id = ?"),
  };
}).immediate();

export type PruneReport = {
  kept: ChatRow[];
  forgotten: (ChatRow & { reason: string; removed?: Record<string, number> })[];
  blocked: (ChatRow & { reason: string; blockers: Blocker[] })[];
  upgraded: (ChatRow & { movedTo: number })[];
  unknown: (ChatRow & { reason: string })[];
};

export const pruneChats = async (db: Database, probe: PresenceProbe, apply: boolean): Promise<PruneReport> => {
  const report: PruneReport = { kept: [], forgotten: [], blocked: [], upgraded: [], unknown: [] };
  const rows = db.query<ChatRow, []>("SELECT id, city, title FROM chats ORDER BY id").all();

  // One at a time: a handful of chats, and Telegram rate-limits bursts.
  for (const chat of rows) {
    const presence = await probe(chat.id);
    if (presence.kind === "present") report.kept.push(chat);
    else if (presence.kind === "upgraded") report.upgraded.push({ ...chat, movedTo: presence.movedTo });
    else if (presence.kind === "unknown") report.unknown.push({ ...chat, reason: presence.reason });
    else {
      const blockers = soleGateOf(db, chat.id);
      if (blockers.length > 0) report.blocked.push({ ...chat, reason: presence.reason, blockers });
      else report.forgotten.push({ ...chat, reason: presence.reason, ...(apply ? { removed: forget(db, chat.id) } : {}) });
    }
  }
  return report;
};

const label = (chat: ChatRow) => `${chat.id} ${chat.title ?? "(no title)"} [${chat.city ?? "unassigned"}]`;

if (import.meta.main) {
  const apply = process.argv.slice(2).includes("--apply");
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is not set.");
    process.exit(1);
  }

  const databasePath = process.env.DATABASE_PATH ?? "./data/sku.db";
  const db = apply ? new Database(databasePath) : new Database(databasePath, { readonly: true });
  db.run("PRAGMA foreign_keys = ON");

  try {
    const report = await pruneChats(db, await telegramProbe(token), apply);

    console.log(`\nStill in ${report.kept.length} chat(s).`);
    for (const chat of report.kept) console.log(`  ${label(chat)}`);

    if (report.upgraded.length > 0) {
      console.log("\nUpgraded to a supergroup — left for the bot to carry over on next use:");
      for (const chat of report.upgraded) console.log(`  ${label(chat)} → ${chat.movedTo}`);
    }

    if (report.blocked.length > 0) {
      console.log("\nBot is out, but kept because the chat is the only gate of something live:");
      for (const chat of report.blocked) {
        console.log(`  ${label(chat)} — ${chat.reason}`);
        for (const blocker of chat.blockers) console.log(`    ${blocker.kind} ${blocker.id}: ${blocker.title}`);
      }
      console.log("  Change those chats in the admin screen, then run this again.");
    }

    if (report.unknown.length > 0) {
      console.error("\nCould not tell — kept:");
      for (const chat of report.unknown) console.error(`  ${label(chat)} — ${chat.reason}`);
      process.exitCode = 1;
    }

    console.log(`\n${apply ? "Forgot" : "Would forget"} ${report.forgotten.length} chat(s):`);
    for (const chat of report.forgotten) {
      console.log(`  ${label(chat)} — ${chat.reason}`);
      if (chat.removed) console.log(`    ${JSON.stringify(chat.removed)}`);
    }
    if (!apply && report.forgotten.length > 0) console.log("\nPreview only. Run the same command with --apply to forget them.");
    if (apply && report.forgotten.length > 0) {
      console.log("\nIf any of these ids are still listed in EVENT_GROUPS, remove them there too, or the next restart files them again.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
