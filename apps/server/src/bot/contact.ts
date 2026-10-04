import { Effect } from "effect";
import { InlineKeyboard, Keyboard, RemoveKeyboard } from "gramio";
import { eq, users } from "@sku/db";

import { db } from "../db";
import { runtime } from "../runtime";
import { sendEventCard } from "./event-card";
import { sendHero } from "./hero";
import { i18n, localeFromLanguageCode } from "./i18n";
import { pendingEventStarts } from "./start";

type TelegramUser = {
  id: number;
  firstName: string;
  lastName: string | undefined;
  username: string | undefined;
  languageCode: string | undefined;
};
type ContactContext = {
  contact: { userId: number | undefined; phoneNumber: string } | undefined;
  from: TelegramUser | undefined;
  send: (text: string | { toString(): string }, params?: { reply_markup?: InlineKeyboard | Keyboard | RemoveKeyboard }) => Promise<unknown>;
};

export const contactHandler = (context: ContactContext): Promise<void> => runtime.runPromise(Effect.gen(function* () {
  const contact = context.contact;
  const telegramUser = context.from;
  if (!contact || !telegramUser) return;

  const locale = db.select({ locale: users.locale }).from(users).where(eq(users.id, telegramUser.id)).get()?.locale
    ?? localeFromLanguageCode(telegramUser.languageCode);
  if (contact.userId !== telegramUser.id) {
    yield* Effect.promise(() => context.send(i18n.t(locale, "contactRejected")));
    return;
  }

  db.insert(users).values({
    id: telegramUser.id,
    firstName: telegramUser.firstName,
    lastName: telegramUser.lastName,
    username: telegramUser.username,
    phone: contact.phoneNumber,
    locale,
  }).onConflictDoUpdate({
    target: users.id,
    set: { phone: contact.phoneNumber },
  }).run();

  yield* Effect.promise(() => context.send(i18n.t(locale, "contactSaved"), { reply_markup: new RemoveKeyboard() }));
  yield* Effect.promise(() => sendHero(context, locale));

  const eventId = pendingEventStarts.get(telegramUser.id);
  if (eventId !== undefined) {
    pendingEventStarts.delete(telegramUser.id);
    yield* sendEventCard(context, eventId, telegramUser.id, locale);
  }
}));
