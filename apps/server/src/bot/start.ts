import { InlineKeyboard, Keyboard, RemoveKeyboard } from "gramio";
import { eq, users } from "@sku/db";

import { db } from "../db";
import { parseStartPayload } from "../core/links";
import { sendEventCard } from "./event-card";
import { sendHero } from "./hero";
import { i18n, localeFromLanguageCode } from "./i18n";

type TelegramUser = {
  id: number;
  firstName: string;
  lastName: string | undefined;
  username: string | undefined;
  languageCode: string | undefined;
};
type StartContext = {
  args: string | null;
  from: TelegramUser | undefined;
  send: (text: string | { toString(): string }, params?: { reply_markup?: InlineKeyboard | Keyboard | RemoveKeyboard }) => Promise<unknown>;
};

export const pendingEventStarts = new Map<number, number>();

export const startHandler = async (context: StartContext): Promise<void> => {
  const telegramUser = context.from;
  if (!telegramUser) return;

  const payload = context.args ? parseStartPayload(context.args) : null;
  if (payload) pendingEventStarts.set(telegramUser.id, payload.eventId);

  db.insert(users).values({
    id: telegramUser.id,
    firstName: telegramUser.firstName,
    lastName: telegramUser.lastName,
    username: telegramUser.username,
    locale: localeFromLanguageCode(telegramUser.languageCode),
  }).onConflictDoNothing().run();

  const user = db.select({ phone: users.phone, locale: users.locale })
    .from(users)
    .where(eq(users.id, telegramUser.id))
    .get();
  const locale = user?.locale ?? localeFromLanguageCode(telegramUser.languageCode);

  if (!user?.phone) {
    if (context.args && !payload) await context.send(i18n.t(locale, "unknownPayload"));
    await context.send(i18n.t(locale, "welcome"));
    await context.send(i18n.t(locale, "contactPrompt"), {
      reply_markup: new Keyboard()
        .requestContact(i18n.t(locale, "contactButton"))
        .oneTime()
        .resized(),
    });
    return;
  }

  if (context.args && !payload) await context.send(i18n.t(locale, "unknownPayload"));
  if (payload) {
    await sendEventCard(context, payload.eventId, locale);
    return;
  }
  await sendHero(context, locale);
};
