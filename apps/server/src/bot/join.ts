import { eq, users } from "@sku/db";

import { chatsOfEvent, refreshMemberships } from "../core/membership";
import { joinEvent } from "../core/registration";
import { db } from "../db";
import { joinCallback } from "./callbacks";
import { renderEventCard } from "./event-card";
import { i18n, localeFromLanguageCode } from "./i18n";
import { telegramMembership } from "./membership";
import type { InlineKeyboard } from "gramio";

type TelegramUser = { id: number; languageCode: string | undefined };
type JoinContext = {
  data: string | undefined;
  from: TelegramUser | undefined;
  answer: () => Promise<true>;
  editText: (text: string | { toString(): string }, params?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
  send: (text: string | { toString(): string }) => Promise<unknown>;
};

/** Signing up straight from the card the deep link produced, without opening the app. */
export const joinHandler = async (context: JoinContext): Promise<void> => {
  await context.answer();

  const unpacked = context.data ? joinCallback.safeUnpack(context.data) : { success: false as const };
  const telegramUser = context.from;
  if (!unpacked.success || !telegramUser) return;

  const eventId = unpacked.data.id;
  const account = db.select({ locale: users.locale }).from(users).where(eq(users.id, telegramUser.id)).get();
  const locale = account?.locale ?? localeFromLanguageCode(telegramUser.languageCode);

  await refreshMemberships(db, telegramMembership, telegramUser.id, chatsOfEvent(db, eventId), new Date());
  const result = joinEvent(db, eventId, telegramUser.id, new Date());

  if ("error" in result) {
    const notice = {
      banned: "bannedNotice",
      not_published: "eventUnavailable",
      event_over: "eventUnavailable",
      already_joined: "alreadyJoinedNotice",
      not_eligible: "notEligibleNotice",
      event_full: "noSpotsLeft",
    } as const;
    await context.send(i18n.t(locale, notice[result.error]));
  } else {
    await context.send(result.status === "registered"
      ? i18n.t(locale, "joinedNotice")
      : i18n.t(locale, "queuedNotice"));
  }

  // Repaint the card so its buttons match the new state.
  const card = renderEventCard(eventId, telegramUser.id, locale);
  if (card) await context.editText(card.text, { reply_markup: card.keyboard });
};
