import type { Db } from "@sku/db";
import { dispatchEffects } from "./notify";
import { sweepOffers } from "./core/waitlist";

export const startSweeper = (db: Db, intervalMs = 30_000) => {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchEffects(sweepOffers(db, new Date()));
    } catch (error) {
      console.error("Offer sweeper failed", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  void run();

  return () => clearInterval(timer);
};
