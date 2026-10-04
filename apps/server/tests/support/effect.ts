import { Effect } from "effect";
import type { Db } from "@sku/db";
import type { PaymentProvider } from "../../src/payments/provider";
import { Database, Payments } from "../../src/services";

type Rejection = { readonly _tag: string; readonly code: string };

/**
 * Business rejections come back in the shape these assertions were written
 * against before actions ran on Effect: `{ error }`, or `{ ok: false, reason }`
 * for a lost offer. Anything thrown still throws.
 */
const settle = <A, E, R>(action: Effect.Effect<A, E, R>) => action.pipe(
  Effect.catch((failure) => {
    const { _tag, code } = failure as Rejection;
    return Effect.succeed(_tag === "OfferRejected" ? { ok: false as const, reason: code } : { error: code });
  }),
);

/** A synchronous action against a test's own database. */
export const run = <A, E>(db: Db, action: Effect.Effect<A, E, Database>) =>
  Effect.runSync(settle(action).pipe(Effect.provideService(Database, db)));

export const runAsync = <A, E>(db: Db, action: Effect.Effect<A, E, Database>) =>
  Effect.runPromise(settle(action).pipe(Effect.provideService(Database, db)));

/** An action that moves money, against a fake provider. */
export const runPaid = <A, E>(db: Db, provider: PaymentProvider, action: Effect.Effect<A, E, Database | Payments>) =>
  Effect.runPromise(settle(action).pipe(Effect.provideService(Database, db), Effect.provideService(Payments, provider)));
