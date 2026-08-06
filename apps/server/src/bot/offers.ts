import { eq, users } from "@sku/db";

import { acceptOffer } from "../core/waitlist";
import { db } from "../db";
import { dispatchEffects } from "../notify";
import { offerCallback } from "./callbacks";
import { eventSummary } from "./event-card";
import { i18n, localeFromLanguageCode } from "./i18n";

type TelegramUser = { id: number; languageCode: string | undefined };
type OfferContext = {
  data: string | undefined;
  from: TelegramUser | undefined;
  answer: () => Promise<true>;
  editText: (text: string | { toString(): string }, params?: { reply_markup?: undefined }) => Promise<unknown>;
};

export const offerHandler = async (context: OfferContext): Promise<void> => {
  await context.answer();

  const unpacked = context.data ? offerCallback.safeUnpack(context.data) : { success: false as const };
  const telegramUser = context.from;
  if (!unpacked.success || !telegramUser) {
    await context.editText(i18n.t("ru", "offerSuperseded"));
    return;
  }

  const account = db.select({ locale: users.locale, isBanned: users.isBanned }).from(users)
    .where(eq(users.id, telegramUser.id)).get();
  const locale = account?.locale ?? localeFromLanguageCode(telegramUser.languageCode);
  if (account?.isBanned) {
    await context.editText(i18n.t(locale, "bannedNotice"), { reply_markup: undefined });
    return;
  }
  const result = acceptOffer(db, unpacked.data.id, telegramUser.id, new Date());
  if (!result.ok) {
    await context.editText(i18n.t(locale, "offerSpotTaken"), { reply_markup: undefined });
    return;
  }

  const summary = eventSummaryFromOffer(unpacked.data.id, locale);
  await context.editText(summary
    ? i18n.t(locale, "offerAccepted", summary.title, summary.date)
    : i18n.t(locale, "offerSuperseded"), { reply_markup: undefined });
  await dispatchEffects(result.effects);
};

const eventSummaryFromOffer = (offerId: number, locale: "ru" | "en") => {
  const offer = db.$client.query<{ event_id: number }, [number]>("SELECT event_id FROM waitlist_offers WHERE id = ?").get(offerId);
  return offer ? eventSummary(offer.event_id, locale) : null;
};
