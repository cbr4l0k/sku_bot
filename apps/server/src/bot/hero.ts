import { InlineKeyboard } from "gramio";

import type { Locale } from "@sku/db";
import { loadEnv } from "../env";
import { i18n } from "./i18n";

const env = loadEnv();

type SendContext = {
  send: (text: string | { toString(): string }, params?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
};

export const sendHero = (context: SendContext, locale: Locale): Promise<unknown> =>
  context.send(i18n.t(locale, "hero"), {
    reply_markup: new InlineKeyboard().webApp(i18n.t(locale, "openApp"), `https://${env.DOMAIN}/`),
  });
