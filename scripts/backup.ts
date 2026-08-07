// Streams a consistent snapshot of the SQLite database to stdout.
// Safe to run while the bot is serving traffic: VACUUM INTO takes a read lock and
// folds any WAL contents into the snapshot, so the result is never a torn copy.
//
//   docker compose exec -T app bun run scripts/backup.ts > sku-backup.db
//
// Nothing but the database bytes may be written to stdout.
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";

const source = process.env.DATABASE_PATH ?? "./data/sku.db";
const snapshot = `/tmp/sku-backup-${process.pid}.db`;

const db = new Database(source, { readonly: true });
try {
  db.exec(`VACUUM INTO '${snapshot}'`);
} finally {
  db.close();
}

try {
  await Bun.write(Bun.stdout, Bun.file(snapshot));
} finally {
  unlinkSync(snapshot);
}
