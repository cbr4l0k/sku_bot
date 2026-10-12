import { Effect } from "effect";
import { InlineKeyboard, TelegramError } from "gramio";

import { eq, ticketTiers, users, type Db } from "@sku/db";
import { leaveCallback, offerKeyboard } from "./bot/callbacks";
import { i18n } from "./bot/i18n";
import { eventSummary } from "./bot/event-card";
import type { EventChange, EventUpdatedFields } from "./bot/event-card";
import { bot } from "./bot";
import { loadEnv } from "./env";
import type { NotificationEffect } from "./core/types";
import { Database } from "./services";

const env = loadEnv();

const localeFor = (db: Db, userId: number) =>
  db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).get()?.locale ?? "ru";

const logTelegramFailure = (action: string, error: unknown) => {
  if (error instanceof TelegramError) {
    console.warn(`Telegram ${action} failed: ${error.message}`);
    return;
  }

  console.warn(`Telegram ${action} failed`, error);
};

const dispatchEffect = Effect.fnUntraced(function* (effect: NotificationEffect) {
  const db = yield* Database;
  const locale = localeFor(db, effect.userId);

  if (["ticket_paid", "ticket_refunded", "ticket_refund_failed", "purchase_paid", "purchase_refunded", "purchase_refund_failed"].includes(effect.kind)) {
    const event = yield* eventSummary(effect.eventId, locale);
    if (!event) return;
    const key = effect.kind === "ticket_paid" ? "ticketPaid"
      : effect.kind === "ticket_refunded" ? "ticketRefunded"
        : effect.kind === "ticket_refund_failed" ? "ticketRefundFailed"
          : effect.kind === "purchase_paid" ? "purchasePaid"
            : effect.kind === "purchase_refunded" ? "purchaseRefunded" : "purchaseRefundFailed";
    const response = yield* Effect.promise(() => bot.api.sendMessage({
      chat_id: effect.userId,
      text: i18n.t(locale, key, event.title),
      suppress: true,
    }));
    if (response instanceof TelegramError) logTelegramFailure("purchase notification", response);
    return;
  }

  if (effect.kind === "offer_created") {
    const event = yield* eventSummary(effect.eventId, locale);
    if (!event) {
      console.warn(`Offer notification skipped: event ${effect.eventId} was not found.`);
      return;
    }
    const response = yield* Effect.promise(() => bot.api.sendMessage({
      chat_id: effect.userId,
      text: effect.broadcast
        ? i18n.t(locale, "offerBroadcast", event.title, event.date)
        : i18n.t(locale, "offer", event.title, event.date),
      reply_markup: offerKeyboard(locale, effect.offerId),
      suppress: true,
    }));

    if (response instanceof TelegramError) {
      logTelegramFailure("offer notification", response);
      return;
    }

    db.$client.query("UPDATE waitlist_offers SET message_id = ? WHERE id = ?")
      .run(response.message_id, effect.offerId);
    return;
  }

  if (effect.kind === "run_reminder") {
    const event = yield* eventSummary(effect.eventId, locale);
    if (!event) return;
    // A paid spot is given back through the app's refund flow, not from chat.
    const paid = Boolean(db.select({ id: ticketTiers.id }).from(ticketTiers).where(eq(ticketTiers.eventId, effect.eventId)).get());
    const keyboard = new InlineKeyboard();
    if (!paid) keyboard.text(i18n.t(locale, "leaveButton"), leaveCallback.pack({ id: effect.eventId, step: "ask" })).row();
    keyboard.webApp(i18n.t(locale, "openEvent"), `https://${env.DOMAIN}/events/${effect.eventId}`);
    const response = yield* Effect.promise(() => bot.api.sendMessage({
      chat_id: effect.userId,
      text: i18n.t(locale, "runReminder", event.title, event.date, event.location, event.locationUrl),
      reply_markup: keyboard,
      suppress: true,
    }));
    if (response instanceof TelegramError) logTelegramFailure("run reminder", response);
    return;
  }

  if (effect.kind !== "offer_superseded") return;

  const messageId = effect.messageId;
  if (messageId !== null) {
    const edit = yield* Effect.promise(() => bot.api.editMessageReplyMarkup({
      chat_id: effect.userId,
      message_id: messageId,
      reply_markup: undefined,
      suppress: true,
    }));
    if (edit instanceof TelegramError) logTelegramFailure("offer keyboard removal", edit);
  }

  const response = yield* Effect.promise(() => bot.api.sendMessage({
    chat_id: effect.userId,
    text: i18n.t(locale, "offerSuperseded"),
    suppress: true,
  }));
  if (response instanceof TelegramError) logTelegramFailure("offer superseded notification", response);
});

/** One at a time, and one failed delivery never holds back the rest. */
export const dispatchEffects = Effect.fn("notify.dispatchEffects")(function* (effects: NotificationEffect[]) {
  for (const effect of effects) {
    yield* dispatchEffect(effect).pipe(
      Effect.catchDefect((error) => Effect.sync(() => logTelegramFailure("notification dispatch", error))),
    );
  }
});

export const notifyEventCanceled = Effect.fn("notify.notifyEventCanceled")(function* (userIds: number[], eventId: number) {
  const db = yield* Database;
  for (const userId of userIds) {
    const locale = localeFor(db, userId);
    const event = yield* eventSummary(eventId, locale);
    if (!event) {
      console.warn(`Event cancellation notification skipped: event ${eventId} was not found.`);
      continue;
    }
    const response = yield* Effect.promise(() => bot.api.sendMessage({
      chat_id: userId,
      text: i18n.t(locale, "eventCanceled", event.title),
      suppress: true,
    }));
    if (response instanceof TelegramError) logTelegramFailure("event cancellation notification", response);
  }
});

export const notifyEventUpdated = Effect.fn("notify.notifyEventUpdated")(function* (userIds: number[], eventId: number, changes: EventChange[]) {
  const db = yield* Database;
  for (const userId of userIds) {
    const locale = localeFor(db, userId);
    const event = yield* eventSummary(eventId, locale);
    if (!event) {
      console.warn(`Event update notification skipped: event ${eventId} was not found.`);
      continue;
    }
    const fields: EventUpdatedFields = {
      ...(changes.includes("title") ? { title: event.title } : {}),
      ...(changes.includes("description") ? { description: true } : {}),
      ...(changes.includes("startsAt") ? { startsAt: event.date } : {}),
      ...(changes.includes("location") ? { location: event.location } : {}),
      ...(changes.includes("capacity") ? { capacity: event.capacity } : {}),
    };
    const response = yield* Effect.promise(() => bot.api.sendMessage({
      chat_id: userId,
      text: i18n.t(locale, "eventUpdated", event.title, fields),
      suppress: true,
    }));
    if (response instanceof TelegramError) logTelegramFailure("event update notification", response);
  }
});
