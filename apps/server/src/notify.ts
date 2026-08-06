import { InlineKeyboard, TelegramError } from "gramio";

import { eq, users } from "@sku/db";
import { offerCallback } from "./bot/callbacks";
import { i18n } from "./bot/i18n";
import { eventSummary } from "./bot/event-card";
import type { EventChange, EventUpdatedFields } from "./bot/event-card";
import { bot } from "./bot";
import { db } from "./db";
import type { NotificationEffect } from "./core/types";

const localeFor = (userId: number) =>
  db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).get()?.locale ?? "ru";

const logTelegramFailure = (action: string, error: unknown) => {
  if (error instanceof TelegramError) {
    console.warn(`Telegram ${action} failed: ${error.message}`);
    return;
  }

  console.warn(`Telegram ${action} failed`, error);
};

const dispatchEffect = async (effect: NotificationEffect): Promise<void> => {
  const locale = localeFor(effect.userId);

  if (effect.kind === "offer_created") {
    const event = eventSummary(effect.eventId, locale);
    if (!event) {
      console.warn(`Offer notification skipped: event ${effect.eventId} was not found.`);
      return;
    }
    const replyMarkup = new InlineKeyboard().text(
      i18n.t(locale, "offerAccept"),
      offerCallback.pack({ id: effect.offerId }),
    );
    const response = await bot.api.sendMessage({
      chat_id: effect.userId,
      text: i18n.t(locale, "offer", event.title, event.date),
      reply_markup: replyMarkup,
      suppress: true,
    });

    if (response instanceof TelegramError) {
      logTelegramFailure("offer notification", response);
      return;
    }

    db.$client.query("UPDATE waitlist_offers SET message_id = ? WHERE id = ?")
      .run(response.message_id, effect.offerId);
    return;
  }

  if (effect.messageId !== null) {
    const edit = await bot.api.editMessageReplyMarkup({
      chat_id: effect.userId,
      message_id: effect.messageId,
      reply_markup: undefined,
      suppress: true,
    });
    if (edit instanceof TelegramError) logTelegramFailure("offer keyboard removal", edit);
  }

  const response = await bot.api.sendMessage({
    chat_id: effect.userId,
    text: i18n.t(locale, "offerSuperseded"),
    suppress: true,
  });
  if (response instanceof TelegramError) logTelegramFailure("offer superseded notification", response);
};

export const dispatchEffects = async (effects: NotificationEffect[]): Promise<void> => {
  for (const effect of effects) {
    try {
      await dispatchEffect(effect);
    } catch (error) {
      logTelegramFailure("notification dispatch", error);
    }
  }
};

export const notifyEventCanceled = async (userIds: number[], eventId: number): Promise<void> => {
  for (const userId of userIds) {
    const locale = localeFor(userId);
    const event = eventSummary(eventId, locale);
    if (!event) {
      console.warn(`Event cancellation notification skipped: event ${eventId} was not found.`);
      continue;
    }
    const response = await bot.api.sendMessage({
      chat_id: userId,
      text: i18n.t(locale, "eventCanceled", event.title),
      suppress: true,
    });
    if (response instanceof TelegramError) logTelegramFailure("event cancellation notification", response);
  }
};

export const notifyEventUpdated = async (userIds: number[], eventId: number, changes: EventChange[]): Promise<void> => {
  for (const userId of userIds) {
    const locale = localeFor(userId);
    const event = eventSummary(eventId, locale);
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
    const response = await bot.api.sendMessage({
      chat_id: userId,
      text: i18n.t(locale, "eventUpdated", event.title, fields),
      suppress: true,
    });
    if (response instanceof TelegramError) logTelegramFailure("event update notification", response);
  }
};
