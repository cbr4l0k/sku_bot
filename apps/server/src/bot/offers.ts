import { Effect } from "effect";
import { eq, users } from "@sku/db";

import { acceptOffer } from "../core/waitlist";
import { dispatchEffects } from "../notify";
import { runtime } from "../runtime";
import { Database } from "../services";
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

export const offerHandler = (context: OfferContext): Promise<void> => runtime.runPromise(Effect.gen(function* () {
  yield* Effect.promise(() => context.answer());

  const unpacked = context.data ? offerCallback.safeUnpack(context.data) : { success: false as const };
  const telegramUser = context.from;
  if (!unpacked.success || !telegramUser) {
    yield* Effect.promise(() => context.editText(i18n.t("ru", "offerSuperseded")));
    return;
  }

  const db = yield* Database;
  const account = db.select({ locale: users.locale, isBanned: users.isBanned }).from(users)
    .where(eq(users.id, telegramUser.id)).get();
  const locale = account?.locale ?? localeFromLanguageCode(telegramUser.languageCode);
  if (account?.isBanned) {
    yield* Effect.promise(() => context.editText(i18n.t(locale, "bannedNotice"), { reply_markup: undefined }));
    return;
  }
  const result = yield* acceptOffer(unpacked.data.id, telegramUser.id, new Date()).pipe(
    Effect.catchTag("OfferRejected", () => Effect.succeed(null)),
  );
  if (!result) {
    yield* Effect.promise(() => context.editText(i18n.t(locale, "offerSpotTaken"), { reply_markup: undefined }));
    return;
  }

  const summary = yield* eventSummaryFromOffer(unpacked.data.id, locale);
  yield* Effect.promise(() => context.editText(summary
    ? i18n.t(locale, "offerAccepted", summary.title, summary.date)
    : i18n.t(locale, "offerSuperseded"), { reply_markup: undefined }));
  yield* dispatchEffects(result.effects);
}));

const eventSummaryFromOffer = Effect.fnUntraced(function* (offerId: number, locale: "ru" | "en") {
  const offer = (yield* Database).$client.query<{ event_id: number }, [number]>("SELECT event_id FROM waitlist_offers WHERE id = ?").get(offerId);
  return offer ? yield* eventSummary(offer.event_id, locale) : null;
});
