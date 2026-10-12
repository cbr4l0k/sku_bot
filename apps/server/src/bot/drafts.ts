import { Effect } from "effect";
import { InlineKeyboard } from "gramio";
import { eq, events, users } from "@sku/db";

import { canAdminCity, loadActor } from "../core/cities";
import { discardDraft, publishDraft } from "../core/drafts";
import { loadEnv } from "../env";
import { runtime } from "../runtime";
import { Database } from "../services";
import { draftCallback, draftKeyboard } from "./callbacks";
import { formatDate } from "./event-card";
import { i18n, localeFromLanguageCode } from "./i18n";

const env = loadEnv();

type TelegramUser = { id: number; languageCode: string | undefined };
type DraftContext = {
  data: string | undefined;
  from: TelegramUser | undefined;
  answer: () => Promise<true>;
  editText: (text: string | { toString(): string }, params?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
  editReplyMarkup: (replyMarkup: InlineKeyboard) => Promise<unknown>;
};

/**
 * Publish or Skip on a series draft's review DM. Rights and state are read again on
 * every tap: the DM may be hours old, and someone may have handled the draft in the app.
 */
export const draftHandler = (context: DraftContext): Promise<void> => runtime.runPromise(Effect.gen(function* () {
  yield* Effect.promise(() => context.answer());

  const unpacked = context.data ? draftCallback.safeUnpack(context.data) : { success: false as const };
  const telegramUser = context.from;
  if (!unpacked.success || !telegramUser) return;

  const { id: eventId, step } = unpacked.data;
  const db = yield* Database;
  const account = db.select({ locale: users.locale, isAdmin: users.isAdmin }).from(users).where(eq(users.id, telegramUser.id)).get();
  const locale = account?.locale ?? localeFromLanguageCode(telegramUser.languageCode);
  const url = `https://${env.DOMAIN}/hq/events/${eventId}`;
  const openOnly = new InlineKeyboard().webApp(i18n.t(locale, "draftOpen"), url);
  const edit = (text: string | { toString(): string }, keyboard?: InlineKeyboard) =>
    Effect.promise(() => context.editText(text, { reply_markup: keyboard }));

  const event = db.select({ city: events.city, status: events.status, title: events.title, startsAt: events.startsAt })
    .from(events).where(eq(events.id, eventId)).get();
  if (!event || event.status !== "draft") {
    yield* edit(i18n.t(locale, "draftHandled"));
    return;
  }

  const actor = yield* loadActor(telegramUser.id, Boolean(account?.isAdmin) || env.ADMIN_IDS.includes(telegramUser.id));
  if (!canAdminCity(actor, event.city)) {
    yield* edit(i18n.t(locale, "draftNotAllowed"), openOnly);
    return;
  }

  if (step === "back") {
    yield* Effect.promise(() => context.editReplyMarkup(draftKeyboard(locale, eventId, url)));
    return;
  }
  if (step === "skip") {
    yield* Effect.promise(() => context.editReplyMarkup(new InlineKeyboard()
      .text(i18n.t(locale, "draftSkipConfirm"), draftCallback.pack({ id: eventId, step: "confirm" }))
      .row()
      .text(i18n.t(locale, "draftSkipKeep"), draftCallback.pack({ id: eventId, step: "back" }))));
    return;
  }
  if (step === "publish") {
    yield* publishDraft(eventId, new Date()).pipe(Effect.andThen((published) => published
      ? edit(i18n.t(locale, "draftPublished", event.title, formatDate(event.startsAt, locale, event.city)), openOnly)
      : edit(i18n.t(locale, "draftHandled"))));
    return;
  }

  yield* discardDraft(eventId).pipe(Effect.andThen((outcome) => ({
    discarded: edit(i18n.t(locale, "draftSkipped", event.title)),
    has_orders: edit(i18n.t(locale, "draftHasOrders"), openOnly),
    not_draft: edit(i18n.t(locale, "draftHandled")),
  })[outcome]));
}));
