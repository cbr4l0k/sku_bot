import { Effect } from "effect";
import { syncChatGuests } from "./bot/guests";
import { dispatchEffects } from "./notify";
import { sweepOffers } from "./core/waitlist";
import { sweepReminders } from "./core/reminders";
import { sweepTicketPayments } from "./core/tickets";
import { dueSeries, spawnOccurrence } from "./core/series";
import { paymentProvider } from "./payments";
import { runtime } from "./runtime";
import { Payments, type Database } from "./services";

/** Each pass stands alone: one failing must not hold back the others. */
const guarded = <E>(name: string, work: () => Effect.Effect<void, E, Database>) => {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await runtime.runPromise(work());
    } catch (error) {
      console.error(`${name} sweeper failed`, error);
    } finally {
      running = false;
    }
  };
};

const every = (intervalMs: number, run: () => Promise<void>) => {
  const timer = setInterval(() => void run(), intervalMs);
  void run();
  return () => clearInterval(timer);
};

/** Templates that are due open their next draft; one that cannot is left for a person to look at. */
const spawnDueSeries = Effect.fn("sweeper.spawnDueSeries")(function* (sweepAt: Date) {
  for (const seriesId of yield* dueSeries(sweepAt)) {
    yield* spawnOccurrence(seriesId, sweepAt).pipe(Effect.catchTag("SeriesRejected", () => Effect.void));
  }
});

/**
 * Offers turn on a 20-minute expiry, so they are swept often. Chat guests are not
 * racing a deadline — a minute between someone taking a spot and the invite landing
 * is nothing — and each pass can cost a Telegram lookup per person, so they get a
 * slower lane of their own rather than riding along every 30 seconds. Series are
 * slower again: their lead is measured in days, and an hourly pass still leaves a
 * human the whole review window promised by the template.
 */
export const startSweeper = (intervalMs = 30_000, guestIntervalMs = 60_000, seriesIntervalMs = 60 * 60 * 1000) => {
  const stopOffers = every(intervalMs, guarded("Offer", () => sweepOffers(new Date()).pipe(Effect.flatMap(dispatchEffects))));
  const stopGuests = every(guestIntervalMs, guarded("Chat guest", () => syncChatGuests(new Date())));
  // Reminders share the guests' minute: a run two hours off is not racing anything.
  const stopReminders = every(guestIntervalMs, guarded("Reminder", () => sweepReminders(new Date()).pipe(Effect.flatMap(dispatchEffects))));
  const stopSeries = every(seriesIntervalMs, guarded("Series", () => spawnDueSeries(new Date())));
  const configuredProvider = paymentProvider;
  const stopPayments = configuredProvider
    ? every(intervalMs, guarded("Payment", () => sweepTicketPayments(new Date()).pipe(
      Effect.flatMap(dispatchEffects),
      Effect.provideService(Payments, configuredProvider),
    )))
    : () => {};

  return () => {
    stopOffers();
    stopGuests();
    stopReminders();
    stopSeries();
    stopPayments();
  };
};
