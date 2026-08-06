import { fileURLToPath } from "node:url";
import { migrate as runMigrations } from "drizzle-orm/bun-sqlite/migrator";
import { createDb, type Db } from "./client";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export const migrate = (db: Db) => runMigrations(db, { migrationsFolder });

if (import.meta.main) {
  const databasePath = process.env.DATABASE_PATH ?? "./data/sku.db";
  const db = createDb(databasePath);
  migrate(db);
}
