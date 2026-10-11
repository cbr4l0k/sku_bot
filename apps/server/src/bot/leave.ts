import { Effect } from "effect";
import { InlineKeyboard } from "gramio";
import { and, eq, events, registrations, ticketTiers, users } from "@sku/db";
import type { Db } from "@sku/db";

import { cancelRegistration } from "../core/registration";
import { dispatchEffects } from "../notify";
import { runtime } from "../runtime";
import { Database } from "../services";
import { declineCallback, leaveCallback, offerKeyboard } from "./callbacks";
import { renderEventCard } from "./event-card";
import { i18n, localeFromLanguageCode } from "./i18n";

type TelegramUser = { id: number; languageCode: string | undefined };
type LeaveContext = {
  data: string | undefined;
  from: TelegramUser | undefined;
  answer: () => Promise<true>;
  editText: (text: string | { toString(): string }, params?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
  editReplyMarkup: (replyMarkup: InlineKeyboard) => Promise<unknown>;
  send: (text: string | { toString(): string }) => Promise<unknown>;
};

/** Whether a free spot or queue place is still the user's to give up — buttons can be days old. */
const canGiveUp = (db: Db, eventId: number, userId: number, statuses: string[]) => {
  const event = db.select({ status: events.status, endedAt: events.endedAt }).from(events).where(eq(events.id, eventId)).get();
  const paid = Boolean(db.select({ id: ticketTiers.id }).from(ticketTiers).where(eq(ticketTiers.eventId, eventId)).get());
  const registration = db.select({ status: registrations.status, isStaff: registrations.isStaff }).from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId))).get();
  const open = event?.status === "published" && event.endedAt === null;
  return open && !paid && registration && !registration.isStaff && statuses.includes(registration.status) ? registration.status : null;
};

const account = (db: Db, user: TelegramUser) => {
  const row = db.select({ locale: users.locale, isBanned: users.isBanned }).from(users).where(eq(users.id, user.id)).get();
  return { locale: row?.locale ?? localeFromLanguageCode(user.languageCode), isBanned: Boolean(row?.isBanned) };
};

/** "Can't make it" on the event card: free events only, and only for someone holding a spot or a queue place. */
export const leaveHandler = (context: LeaveContext): Promise<void> => runtime.runPromise(Effect.gen(function* () {
  yield* Effect.promise(() => context.answer());

  const unpacked = context.data ? leaveCallback.safeUnpack(context.data) : { success: false as const };
  const telegramUser = context.from;
  if (!unpacked.success || !telegramUser) return;

  const { id: eventId, step } = unpacked.data;
  const db = yield* Database;
  const { locale, isBanned } = account(db, telegramUser);
  const repaint = Effect.fnUntraced(function* () {
    const card = yield* renderEventCard(eventId, telegramUser.id, locale);
    yield* Effect.promise(() => card
      ? context.editText(card.text, { reply_markup: card.keyboard })
      : context.editText(i18n.t(locale, "eventUnavailable")));
  });

  const status = canGiveUp(db, eventId, telegramUser.id, ["registered", "waitlisted"]);
  if (step === "back" || !status) return yield* repaint();
  if (step === "ask") {
    yield* Effect.promise(() => context.editReplyMarkup(new InlineKeyboard()
      .text(i18n.t(locale, status === "waitlisted" ? "leaveQueueConfirm" : "leaveConfirm"), leaveCallback.pack({ id: eventId, step: "confirm" }))
      .row()
      .text(i18n.t(locale, "leaveKeep"), leaveCallback.pack({ id: eventId, step: "back" }))));
    return;
  }
  if (isBanned) {
    yield* Effect.promise(() => context.send(i18n.t(locale, "bannedNotice")));
    return;
  }

  // The freed spot is offered before any of this chat's own edits, which may fail.
  const { effects } = yield* cancelRegistration(eventId, telegramUser.id, new Date());
  yield* dispatchEffects(effects);
  yield* Effect.promise(() => context.send(i18n.t(locale, status === "waitlisted" ? "leftQueueNotice" : "leftNotice")));
  yield* repaint();
}));

/** "Decline" on an offer DM: passing on the spot means leaving the queue, or the same spot would come straight back. */
export const declineHandler = (context: LeaveContext): Promise<void> => runtime.runPromise(Effect.gen(function* () {
  yield* Effect.promise(() => context.answer());

  const unpacked = context.data ? declineCallback.safeUnpack(context.data) : { success: false as const };
  const telegramUser = context.from;
  if (!unpacked.success || !telegramUser) return;

  const { id: offerId, step } = unpacked.data;
  const db = yield* Database;
  const { locale, isBanned } = account(db, telegramUser);
  const offer = db.$client.query<{ event_id: number; user_id: number; status: string }, [number]>(
    "SELECT event_id, user_id, status FROM waitlist_offers WHERE id = ?",
  ).get(offerId);
  // A ticket bought since, or an event closed since, makes the offer moot rather than declinable.
  if (!offer || offer.user_id !== telegramUser.id || offer.status !== "pending" || !canGiveUp(db, offer.event_id, telegramUser.id, ["waitlisted"])) {
    yield* Effect.promise(() => context.editText(i18n.t(locale, "offerSuperseded"), { reply_markup: undefined }));
    return;
  }

  if (step === "back") {
    yield* Effect.promise(() => context.editReplyMarkup(offerKeyboard(locale, offerId)));
    return;
  }
  if (step === "ask") {
    yield* Effect.promise(() => context.editReplyMarkup(new InlineKeyboard()
      .text(i18n.t(locale, "offerDeclineConfirm"), declineCallback.pack({ id: offerId, step: "confirm" }))
      .row()
      .text(i18n.t(locale, "offerDeclineKeep"), declineCallback.pack({ id: offerId, step: "back" }))));
    return;
  }
  if (isBanned) {
    yield* Effect.promise(() => context.editText(i18n.t(locale, "bannedNotice"), { reply_markup: undefined }));
    return;
  }

  const { effects } = yield* cancelRegistration(offer.event_id, telegramUser.id, new Date());
  yield* dispatchEffects(effects);
  yield* Effect.promise(() => context.editText(i18n.t(locale, "offerDeclined"), { reply_markup: undefined }));
}));
