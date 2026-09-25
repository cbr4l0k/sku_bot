// Validates and restores a SQLite snapshot created by backup.ts.
//
// Preview (default):
//   bun run scripts/restore.ts <backup.db>
// Apply (the application using DATABASE_PATH must be stopped first):
//   bun run scripts/restore.ts <backup.db> --apply
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith("--"));
const positional = args.filter((argument) => !argument.startsWith("--"));
const unknown = flags.filter((flag) => flag !== "--apply");
const apply = flags.includes("--apply");

if (positional.length !== 1 || unknown.length > 0) {
  if (unknown.length > 0) console.error(`Unknown option: ${unknown.join(" ")}`);
  console.error("Usage: bun run scripts/restore.ts <backup.db> [--apply]");
  process.exit(1);
}

const sourceArgument = positional[0]!;
const targetPath = resolve(process.env.DATABASE_PATH ?? "./data/sku.db");

type CheckRow = { quick_check: string };
type CountRow = { count: number };
type DatabaseSummary = {
  bytes: number;
  modified: string;
  pages: number;
  pageSize: number;
  userVersion: number;
  tables: number;
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const inspectDatabase = (path: string): DatabaseSummary => {
  const file = statSync(path);
  if (!file.isFile()) throw new Error(`${path} is not a regular file.`);
  if (file.size === 0) throw new Error(`${path} is empty.`);

  const db = new Database(path, { readonly: true });
  try {
    const checks = db.query<CheckRow, []>("PRAGMA quick_check").all();
    if (checks.length !== 1 || checks[0]?.quick_check !== "ok") {
      throw new Error(`SQLite quick_check failed: ${checks.map((row) => row.quick_check).join("; ")}`);
    }

    const foreignKeyProblems = db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
    if (foreignKeyProblems.length > 0) {
      throw new Error(`SQLite foreign_key_check found ${foreignKeyProblems.length} problem(s).`);
    }

    const tables = db.query<CountRow, []>(`
      SELECT count(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).get()?.count ?? 0;

    return {
      bytes: file.size,
      modified: file.mtime.toISOString(),
      pages: db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0,
      pageSize: db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0,
      userVersion: db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
      tables,
    };
  } finally {
    db.close();
  }
};

const printSummary = (label: string, path: string, summary: DatabaseSummary): void => {
  console.log(`${label}: ${path}`);
  console.table([{
    bytes: summary.bytes,
    modified: summary.modified,
    pages: summary.pages,
    page_size: summary.pageSize,
    user_version: summary.userVersion,
    tables: summary.tables,
  }]);
};

const snapshotCurrentDatabase = (destination: string): void => {
  const db = new Database(targetPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO ${sqlString(destination)}`);
  } finally {
    db.close();
  }
};

let stagedPath: string | undefined;

try {
  const sourcePath = resolve(sourceArgument);

  if (!existsSync(sourcePath)) throw new Error(`Backup does not exist: ${sourcePath}`);

  const sourceStat = statSync(sourcePath);
  if (existsSync(targetPath)) {
    const targetStat = statSync(targetPath);
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
      throw new Error("The backup and DATABASE_PATH refer to the same file.");
    }
  }

  const sourceSummary = inspectDatabase(sourcePath);
  printSummary("Validated backup", sourcePath, sourceSummary);

  if (existsSync(targetPath)) {
    printSummary("Current database", targetPath, inspectDatabase(targetPath));
  } else {
    console.log(`Current database: ${targetPath} does not exist and would be created.`);
  }

  if (!apply) {
    console.log("Preview only: the validated backup would replace the current database.");
    console.log("Stop the application, then run the same command with --apply to restore it.");
  } else {
    const targetDirectory = dirname(targetPath);
    const stamp = new Date().toISOString().replaceAll(":", "-");
    stagedPath = resolve(targetDirectory, `.${basename(targetPath)}.restore-${process.pid}.tmp`);
    copyFileSync(sourcePath, stagedPath, 0);
    inspectDatabase(stagedPath);

    let recoveryPath: string | undefined;
    if (existsSync(targetPath)) {
      recoveryPath = resolve(targetDirectory, `${basename(targetPath)}.pre-restore-${stamp}`);
      snapshotCurrentDatabase(recoveryPath);
      inspectDatabase(recoveryPath);
    }

    // These files belong to the old database and must never be paired with the
    // restored main file. A cleanly stopped application normally removes them.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${targetPath}${suffix}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }

    renameSync(stagedPath, targetPath);
    stagedPath = undefined;

    console.log(`Restore complete: ${targetPath}`);
    if (recoveryPath) console.log(`Previous database snapshot: ${recoveryPath}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (stagedPath && existsSync(stagedPath)) unlinkSync(stagedPath);
}
