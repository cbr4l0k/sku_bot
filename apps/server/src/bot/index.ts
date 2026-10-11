import { Bot, Plugin } from "gramio";
import { users } from "@sku/db";
import { loadEnv } from "../env";
import { runtime } from "../runtime";
import { Database } from "../services";
import { i18n, localeFromLanguageCode } from "./i18n";
import { declineCallback, joinCallback, leaveCallback } from "./callbacks";
import { chatIdHandler, chatMembershipHandler } from "./chat-id";
import { contactHandler } from "./contact";
import { joinHandler } from "./join";
import { declineHandler, leaveHandler } from "./leave";
import { offerHandler } from "./offers";
import { startHandler } from "./start";

const env = loadEnv();

const i18nPlugin = new Plugin("sku-i18n").derive(["message", "callback_query"], (context) => {
  const telegramUser = context.from;
  // gramio derives synchronously, so the lookup runs to completion right here.
  const savedUser = runtime.runSync(Database.useSync((db) => db.select({ id: users.id, locale: users.locale }).from(users).all()
    .find((user) => user.id === telegramUser.id)));
  const locale = savedUser?.locale ?? localeFromLanguageCode(telegramUser?.languageCode);

  return { locale, t: i18n.buildT(locale) };
});

export const bot = new Bot(env.BOT_TOKEN)
  .extend(i18nPlugin)
  .command("start", startHandler)
  .command("chatid", chatIdHandler)
  .on("my_chat_member", chatMembershipHandler)
  .on("message", contactHandler)
  // One callback_query stream, several kinds of button: route by the packed prefix.
  .on("callback_query", (context) => {
    const data = typeof context.data === "string" ? context.data : undefined;
    if (data && joinCallback.safeUnpack(data).success) return joinHandler(context);
    if (data && leaveCallback.safeUnpack(data).success) return leaveHandler(context);
    if (data && declineCallback.safeUnpack(data).success) return declineHandler(context);
    return offerHandler(context);
  })
  .onStart(async () => {
    await Promise.all([
      bot.api.setMyCommands({
        language_code: "ru",
        commands: [
          { command: "start", description: i18n.t("ru", "commandStart") },
          { command: "chatid", description: i18n.t("ru", "commandChatId") },
        ],
      }),
      bot.api.setMyCommands({
        language_code: "en",
        commands: [
          { command: "start", description: i18n.t("en", "commandStart") },
          { command: "chatid", description: i18n.t("en", "commandChatId") },
        ],
      }),
    ]);
  })
  .onError(({ kind, error }) => {
    console.error(`[bot:${kind}]`, error);
  });
