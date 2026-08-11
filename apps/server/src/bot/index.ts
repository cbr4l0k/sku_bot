import { Bot, Plugin } from "gramio";
import { users } from "@sku/db";
import { db } from "../db";
import { loadEnv } from "../env";
import { i18n, localeFromLanguageCode } from "./i18n";
import { joinCallback } from "./callbacks";
import { chatIdHandler, chatMembershipHandler } from "./chat-id";
import { contactHandler } from "./contact";
import { joinHandler } from "./join";
import { offerHandler } from "./offers";
import { startHandler } from "./start";

const env = loadEnv();

const i18nPlugin = new Plugin("sku-i18n").derive(["message", "callback_query"], (context) => {
  const telegramUser = context.from;
  const savedUser = db.select({ id: users.id, locale: users.locale }).from(users).all()
    .find((user) => user.id === telegramUser.id);
  const locale = savedUser?.locale ?? localeFromLanguageCode(telegramUser?.languageCode);

  return { locale, t: i18n.buildT(locale) };
});

export const bot = new Bot(env.BOT_TOKEN)
  .extend(i18nPlugin)
  .command("start", startHandler)
  .command("chatid", chatIdHandler)
  .on("my_chat_member", chatMembershipHandler)
  .on("message", contactHandler)
  // One callback_query stream, two kinds of button: route by the packed prefix.
  .on("callback_query", (context) => {
    const data = typeof context.data === "string" ? context.data : undefined;
    return data && joinCallback.safeUnpack(data).success ? joinHandler(context) : offerHandler(context);
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
