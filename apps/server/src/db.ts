import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createDb, migrate } from "@sku/db";
import { loadEnv } from "./env";

const env = loadEnv();

mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });

export const db = createDb(env.DATABASE_PATH);
migrate(db);
