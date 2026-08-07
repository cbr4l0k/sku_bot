import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import { syncConfiguredAdmins } from "../../src/core/admins";
import { loadEnv } from "../../src/env";

const base = { BOT_TOKEN: "12345:token", DOMAIN: "club.example.com", WEBHOOK_SECRET: "webhook", CHECKIN_SECRET: "checkin", NODE_ENV: "test" };
const parse = (ADMIN_IDS: string) => loadEnv({ ...base, ADMIN_IDS }).ADMIN_IDS;

describe("ADMIN_IDS parsing", () => {
  test("accepts several ids", () => { expect(parse("5622866164,112814433")).toEqual([5622866164, 112814433]); });
  test("tolerates whitespace and a trailing comma", () => { expect(parse(" 1001 , 2002 ,\n")).toEqual([1001, 2002]); });
  test("rejects non-numeric, negative, and empty lists", () => {
    expect(() => parse("1001,oops")).toThrow(/"oops" is not a Telegram user id/);
    expect(() => parse("-5")).toThrow(/"-5" is not a Telegram user id/);
    expect(() => parse(" , ")).toThrow(/at least one Telegram user id/);
  });
});

describe("configured admin reconciliation", () => {
  let db: Db;
  const isAdmin = (id: number) => db.$client.query<{ is_admin: number }, [number]>("SELECT is_admin FROM users WHERE id = ?").get(id)?.is_admin === 1;
  beforeEach(() => { db = createDb(":memory:"); migrate(db); for (const id of [1001, 2002, 3003]) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`); });

  test("lifts every configured id that already has a row and leaves the rest alone", () => {
    syncConfiguredAdmins(db, [1001, 2002, 9009]);
    expect(isAdmin(1001)).toBe(true);
    expect(isAdmin(2002)).toBe(true);
    expect(isAdmin(3003)).toBe(false);
  });

  test("is idempotent and never demotes a db-promoted admin", () => {
    db.$client.query("UPDATE users SET is_admin = 1 WHERE id = 3003").run();
    syncConfiguredAdmins(db, [1001]);
    syncConfiguredAdmins(db, [1001]);
    expect(isAdmin(1001)).toBe(true);
    expect(isAdmin(3003)).toBe(true);
  });
});
