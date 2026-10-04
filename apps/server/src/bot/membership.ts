import { Effect } from "effect";
import { chatById, recordChatState } from "../core/chats";
import type { MembershipProbe } from "../core/membership";
import { runtime } from "../runtime";
import { bot } from "./index";

/** Statuses that mean the user is in the chat right now. */
const PRESENT = new Set(["creator", "administrator", "member"]);

/** Telegram answers a lookup on an upgraded group with the supergroup's new id. */
const migrateTarget = (error: unknown): number | null =>
  (error as { payload?: { migrate_to_chat_id?: number } }).payload?.migrate_to_chat_id ?? null;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Telegram is the source of truth for membership. The bot must be an
 * administrator in the chat, otherwise the lookup fails and we report "unknown"
 * rather than guessing.
 */
export const telegramMembership: MembershipProbe = async (chatId, userId) => {
  try {
    const member = await bot.api.getChatMember({ chat_id: chatId, user_id: userId });
    if (member.status === "restricted") return { isMember: member.is_member };
    return { isMember: PRESENT.has(member.status) };
  } catch (error) {
    const movedTo = migrateTarget(error);
    if (movedTo !== null) {
      console.warn(`[chat] ${chatId} was upgraded to a supergroup — now ${movedTo}; carrying it over.`);
      return { movedTo };
    }
    console.error(`getChatMember failed for chat ${chatId}:`, error);
    return null;
  }
};

/* ------------------------------------------------------------- chat diagnostics */

const TITLE_TTL_MS = 30 * 60 * 1000;

/** What the admin UI needs to know about a catalogued chat. */
export type ChatState = { title: string | null; problem: string | null; movedTo: number | null };

/**
 * A chat's last known name and health live on its row rather than in memory, so a
 * restart does not blank every chat name in the admin UI — and so `eventView`,
 * which reads them synchronously per event, never has to render a raw chat id
 * while a cache warms. `movedTo` stays in memory: it is a transient answer about a
 * chat that is in the middle of being carried over, not a fact about the new one.
 */
const migrations = new Map<number, number>();

export const chatTitle = (chatId: number): string | null => runtime.runSync(chatById(chatId))?.title ?? null;

export const chatState = (chatId: number): ChatState => {
  const row = runtime.runSync(chatById(chatId));
  return { title: row?.title ?? null, problem: row?.problem ?? null, movedTo: migrations.get(chatId) ?? null };
};

const selfId = async (): Promise<number> => bot.info?.id ?? (await bot.api.getMe()).id;

/**
 * `getChat` alone is a poor health check: it still resolves the old id of a group
 * that has been upgraded, so a dead chat looks fine. Probing the bot's own
 * membership uses the same call the real checks use, and so fails the same way.
 */
export const refreshChatStates = Effect.fn("chats.refreshChatStates")(function* (chatIds: readonly number[], now: Date = new Date()) {
  const stale = yield* Effect.filter([...new Set(chatIds)], (chatId) => chatById(chatId).pipe(
    Effect.map((row) => !row?.checkedAt || now.getTime() - row.checkedAt.getTime() >= TITLE_TTL_MS),
  ));
  if (stale.length === 0) return;

  const botId = yield* Effect.promise(() => selfId().catch(() => null));
  yield* Effect.forEach(stale, (chatId) => Effect.gen(function* () {
    const state = yield* Effect.promise(async () => {
      try {
        if (botId !== null) await bot.api.getChatMember({ chat_id: chatId, user_id: botId });
        const chat = await bot.api.getChat({ chat_id: chatId });
        migrations.delete(chatId);
        return { title: "title" in chat && chat.title ? chat.title : null, problem: null };
      } catch (error) {
        const movedTo = migrateTarget(error);
        if (movedTo === null) migrations.delete(chatId);
        else migrations.set(chatId, movedTo);
        return { title: null, problem: describe(error) };
      }
    });
    yield* recordChatState(chatId, state, now);
  }), { concurrency: "unbounded", discard: true });
});
