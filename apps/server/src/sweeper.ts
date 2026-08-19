import type { Db } from "@sku/db";
import { syncChatGuests } from "./bot/guests";
import { dispatchEffects } from "./notify";
import { sweepOffers } from "./core/waitlist";

/** Each pass stands alone: one failing must not hold back the others. */
const guarded = (name: string, work: () => Promise<void>) => {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await work();
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

/**
 * Offers turn on a 20-minute expiry, so they are swept often. Chat guests are not
 * racing a deadline — a minute between someone taking a spot and the invite landing
 * is nothing — and each pass can cost a Telegram lookup per person, so they get a
 * slower lane of their own rather than riding along every 30 seconds.
 */
export const startSweeper = (db: Db, intervalMs = 30_000, guestIntervalMs = 60_000) => {
  const stopOffers = every(intervalMs, guarded("Offer", () => dispatchEffects(sweepOffers(db, new Date()))));
  const stopGuests = every(guestIntervalMs, guarded("Chat guest", () => syncChatGuests(db, new Date())));

  return () => {
    stopOffers();
    stopGuests();
  };
};
