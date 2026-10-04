import { Effect } from "effect";
import { inArray, users } from "@sku/db";
import { Database } from "../services";

/**
 * Env-configured admins are an unrevokable floor on top of `users.is_admin`.
 * Rows that already exist are lifted here at boot; rows created later get the
 * flag at insert time (see api/auth.ts and bot/start.ts).
 */
export const syncConfiguredAdmins = Effect.fn("admins.syncConfiguredAdmins")(function* (adminIds: readonly number[]) {
  const db = yield* Database;
  if (adminIds.length === 0) return;
  db.update(users).set({ isAdmin: true }).where(inArray(users.id, [...adminIds])).run();
});
