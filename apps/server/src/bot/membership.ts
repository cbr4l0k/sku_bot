import type { MembershipProbe } from "../core/membership";
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
      console.warn(`[chat] ${chatId} was upgraded to a supergroup — now ${movedTo}. Update EVENT_GROUPS.`);
      return { movedTo };
    }
    console.error(`getChatMember failed for chat ${chatId}:`, error);
    return null;
  }
};

/* ------------------------------------------------------------- chat diagnostics */

const TITLE_TTL_MS = 30 * 60 * 1000;

/** What the admin UI needs to know about a configured chat. */
export type ChatState = { title: string | null; problem: string | null; movedTo: number | null };

const chats = new Map<number, ChatState & { fetchedAt: number }>();

export const chatTitle = (chatId: number): string | null => chats.get(chatId)?.title ?? null;

export const chatState = (chatId: number): ChatState =>
  chats.get(chatId) ?? { title: null, problem: null, movedTo: null };

const selfId = async (): Promise<number> => bot.info?.id ?? (await bot.api.getMe()).id;

/**
 * `getChat` alone is a poor health check: it still resolves the old id of a group
 * that has been upgraded, so a dead chat looks fine. Probing the bot's own
 * membership uses the same call the real checks use, and so fails the same way.
 */
export const refreshChatStates = async (chatIds: readonly number[], now: Date = new Date()): Promise<void> => {
  const stale = chatIds.filter((chatId) => {
    const cached = chats.get(chatId);
    return !cached || now.getTime() - cached.fetchedAt >= TITLE_TTL_MS;
  });
  if (stale.length === 0) return;

  const botId = await selfId().catch(() => null);
  await Promise.all(stale.map(async (chatId) => {
    const state: ChatState & { fetchedAt: number } = { title: null, problem: null, movedTo: null, fetchedAt: now.getTime() };
    try {
      if (botId !== null) await bot.api.getChatMember({ chat_id: chatId, user_id: botId });
      const chat = await bot.api.getChat({ chat_id: chatId });
      if ("title" in chat && chat.title) state.title = chat.title;
    } catch (error) {
      state.problem = describe(error);
      state.movedTo = migrateTarget(error);
    }
    chats.set(chatId, state);
  }));
};
