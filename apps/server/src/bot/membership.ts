import type { MembershipProbe } from "../core/membership";
import { bot } from "./index";

/** Statuses that mean the user is in the chat right now. */
const PRESENT = new Set(["creator", "administrator", "member"]);

/**
 * Telegram is the source of truth for membership. The bot must be an
 * administrator in the chat, otherwise the lookup fails and we report "unknown"
 * rather than guessing.
 */
export const telegramMembership: MembershipProbe = async (chatId, userId) => {
  try {
    const member = await bot.api.getChatMember({ chat_id: chatId, user_id: userId });
    if (member.status === "restricted") return member.is_member;
    return PRESENT.has(member.status);
  } catch (error) {
    console.error(`getChatMember failed for chat ${chatId}:`, error);
    return null;
  }
};

/* ----------------------------------------------------------------- chat titles */

const TITLE_TTL_MS = 30 * 60 * 1000;
const titles = new Map<number, { title: string; fetchedAt: number }>();

/** The chat's title, falling back to its id until Telegram has answered once. */
export const chatTitle = (chatId: number): string => titles.get(chatId)?.title ?? String(chatId);

export const refreshChatTitles = async (chatIds: readonly number[], now: Date = new Date()): Promise<void> => {
  const stale = chatIds.filter((chatId) => {
    const cached = titles.get(chatId);
    return !cached || now.getTime() - cached.fetchedAt >= TITLE_TTL_MS;
  });
  await Promise.all(stale.map(async (chatId) => {
    try {
      const chat = await bot.api.getChat({ chat_id: chatId });
      if ("title" in chat && chat.title) titles.set(chatId, { title: chat.title, fetchedAt: now.getTime() });
    } catch (error) {
      console.error(`getChat failed for chat ${chatId}:`, error);
    }
  }));
};
