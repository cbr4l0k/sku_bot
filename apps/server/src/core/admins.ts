import { inArray, users, type Db } from "@sku/db";

/**
 * Env-configured admins are an unrevokable floor on top of `users.is_admin`.
 * Rows that already exist are lifted here at boot; rows created later get the
 * flag at insert time (see api/auth.ts and bot/start.ts).
 */
export const syncConfiguredAdmins = (db: Db, adminIds: readonly number[]): void => {
  if (adminIds.length === 0) return;
  db.update(users).set({ isAdmin: true }).where(inArray(users.id, [...adminIds])).run();
};
