import { CallbackData, InlineKeyboard } from "gramio";
import type { Locale } from "@sku/db";
import { i18n } from "./i18n";

export const offerCallback = new CallbackData("offer").number("id");
export const joinCallback = new CallbackData("join").number("id");
/** Leaving or passing on a spot is two taps: the first only swaps in a yes/no pair. */
const steps = ["ask", "confirm", "back"] as const;
export const leaveCallback = new CallbackData("leave").number("id").enum("step", steps);
export const declineCallback = new CallbackData("decline").number("id").enum("step", steps);
/** A series draft raised for review: publish it, or skip this run after a second tap. */
export const draftCallback = new CallbackData("draft").number("id").enum("step", ["publish", "skip", "confirm", "back"] as const);

/** The offer DM's own buttons, also restored when someone backs out of declining. */
export const offerKeyboard = (locale: Locale, offerId: number) => new InlineKeyboard()
  .text(i18n.t(locale, "offerAccept"), offerCallback.pack({ id: offerId }))
  .text(i18n.t(locale, "offerDecline"), declineCallback.pack({ id: offerId, step: "ask" }));

/** The review DM's buttons, also restored when someone backs out of skipping. */
export const draftKeyboard = (locale: Locale, eventId: number, url: string) => new InlineKeyboard()
  .text(i18n.t(locale, "draftPublish"), draftCallback.pack({ id: eventId, step: "publish" }))
  .text(i18n.t(locale, "draftSkip"), draftCallback.pack({ id: eventId, step: "skip" }))
  .row()
  .webApp(i18n.t(locale, "draftOpen"), url);
