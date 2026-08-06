import { Bot, Plugin } from "gramio";
import { users } from "@sku/db";
import { db } from "../db";
import { loadEnv } from "../env";
import { i18n, localeFromLanguageCode } from "./i18n";
import { offerCallback } from "./callbacks";
import { contactHandler } from "./contact";
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
  .on("message", contactHandler)
  .on("callback_query", offerHandler)
  .onStart(async () => {
    await Promise.all([
      bot.api.setMyCommands({
        language_code: "ru",
        commands: [{ command: "start", description: i18n.t("ru", "commandStart") }],
      }),
      bot.api.setMyCommands({
        language_code: "en",
        commands: [{ command: "start", description: i18n.t("en", "commandStart") }],
      }),
    ]);
  })
  .onError(({ kind, error }) => {
    console.error(`[bot:${kind}]`, error);
  });
