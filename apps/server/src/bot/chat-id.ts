import { Effect } from "effect";
import type { Locale } from "@sku/db";
import { eq, users } from "@sku/db";

import { rememberChat } from "../core/chats";
import { loadEnv } from "../env";
import { runtime } from "../runtime";
import { Database } from "../services";
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

const isAdmin = (userId: number) => Database.useSync((db): boolean =>
  env.ADMIN_IDS.includes(userId) ||
  db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId)).get()?.isAdmin === true);

const localeOf = (userId: number) => Database.useSync((db): Locale =>
  db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).get()?.locale ?? "ru");

/**
 * Telegram never shows a group's numeric id in the app. The bot files chats it is
 * added to on its own, so this is the fallback for a chat it joined before it knew
 * to look — admins run /chatid inside the group to read the id off.
 */
export const chatIdHandler = (context: ChatIdContext): Promise<void> => runtime.runPromise(Effect.gen(function* () {
  const userId = context.from?.id;
  if (userId === undefined || !(yield* isAdmin(userId))) return;

  const locale = yield* localeOf(userId);
  if (context.chat.type === "private") {
    yield* Effect.promise(() => context.send(i18n.t(locale, "chatIdOnlyInGroups")));
    return;
  }
  yield* Effect.promise(() => context.send(i18n.t(locale, "chatId", context.chat.id)));
}));

/**
 * Files the chat the moment the bot joins it, so setup needs no command at all.
 * The row lands with no branch and is inert until a general admin says which one
 * it belongs to — being discovered grants a chat nothing on its own.
 */
export const chatMembershipHandler = (context: ChatMemberContext): void => {
  const { chat, new_chat_member: member } = context.payload;
  if (chat.type === "private") return;
  console.info(`[chat] bot is now "${member.status}" in ${chat.title ?? chat.type} — id ${chat.id}`);
  runtime.runSync(rememberChat(chat.id, chat.title ?? null, new Date()));
};
