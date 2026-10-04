import { Context, Effect } from "effect";
import type { Db } from "@sku/db";
import type { PaymentProvider } from "./payments/provider";

/** The SQLite database every action reads and writes. */
export class Database extends Context.Service<Database, Db>()("sku/server/Database") {}

/**
 * The configured payment provider. Payments are optional, so this is not part of
 * the server runtime: the callers that move money already check configuration and
 * provide it there.
 */
export class Payments extends Context.Service<Payments, PaymentProvider>()("sku/server/Payments") {}

/** For one-shot tools that open their own database and provider instead of booting the server. */
export const runStandalone = <A, E>(action: Effect.Effect<A, E, Database | Payments>, db: Db, provider: PaymentProvider) =>
  Effect.runPromise(action.pipe(Effect.provideService(Database, db), Effect.provideService(Payments, provider)));
