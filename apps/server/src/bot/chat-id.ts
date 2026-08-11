import type { Locale } from "@sku/db";
import { eq, users } from "@sku/db";

import { db } from "../db";
import { loadEnv } from "../env";
import { i18n } from "./i18n";

const env = loadEnv();

type ChatIdContext = {
  chat: { id: number; type: string };
  from: { id: number } | undefined;
  send: (text: string | { toString(): string }) => Promise<unknown>;
};

type ChatMemberContext = {
  payload: {
    chat: { id: number; title?: string; type: string };
    new_chat_member: { status: string };
  };
};

const isAdmin = (userId: number): boolean =>
  env.ADMIN_IDS.includes(userId) ||
  db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId)).get()?.isAdmin === true;

const localeOf = (userId: number): Locale =>
  db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).get()?.locale ?? "ru";

/**
 * Telegram never shows a group's numeric id in the app, but EVENT_GROUPS needs it.
 * Admins run /chatid inside the group to read it off.
 */
export const chatIdHandler = async (context: ChatIdContext): Promise<void> => {
  const userId = context.from?.id;
  if (userId === undefined || !isAdmin(userId)) return;

  const locale = localeOf(userId);
  if (context.chat.type === "private") {
    await context.send(i18n.t(locale, "chatIdOnlyInGroups"));
    return;
  }
  await context.send(i18n.t(locale, "chatId", context.chat.id));
};

/** Logs the id the moment the bot joins a chat, so setup needs no command at all. */
export const chatMembershipHandler = (context: ChatMemberContext): void => {
  const { chat, new_chat_member: member } = context.payload;
  if (chat.type === "private") return;
  console.info(`[chat] bot is now "${member.status}" in ${chat.title ?? chat.type} — id ${chat.id}`);
};
