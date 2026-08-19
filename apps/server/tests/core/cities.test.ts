import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, events, migrate, userCityRoles, users, type Db } from "@sku/db";

import {
  adminCities,
  canAdminCity,
  canCreateEventIn,
  canGrantRole,
  canManageEvent,
  inCityForUser,
  loadActor,
  organizerCities,
  timezoneOf,
  type Actor,
} from "../../src/core/cities";
import { and, asc, eq, isNull } from "@sku/db";

const seedUser = (db: Db, id: number) =>
  db.insert(users).values({ id, firstName: `u${id}` }).onConflictDoNothing().run();

const seedEvent = (db: Db, id: number, city: "spb" | "msk" | "kzn") =>
  db.insert(events).values({
    id, city, title: `e${id}`, description: "", startsAt: new Date("2030-06-01T09:00:00Z"),
    location: "park", status: "published", createdBy: 1,
  }).run();

const actorOf = (isGlobalAdmin: boolean, roles: [string, "admin" | "organizer"][] = []): Actor => ({
  userId: 7,
  isGlobalAdmin,
  roles: new Map(roles as ["spb" | "msk" | "kzn", "admin" | "organizer"][]),
});

describe("the branch ladder", () => {
  const general = actorOf(true);
  const mskAdmin = actorOf(false, [["msk", "admin"]]);
  const kznOrganizer = actorOf(false, [["kzn", "organizer"]]);
  const nobody = actorOf(false);

  test("a general admin runs every branch", () => {
    for (const city of ["spb", "msk", "kzn"] as const) {
      expect(canAdminCity(general, city)).toBe(true);
      expect(canCreateEventIn(general, city)).toBe(true);
    }
    expect(adminCities(general)).toEqual(["spb", "msk", "kzn"]);
  });

  test("a branch admin runs exactly one branch", () => {
    expect(canAdminCity(mskAdmin, "msk")).toBe(true);
    expect(canAdminCity(mskAdmin, "spb")).toBe(false);
    expect(canAdminCity(mskAdmin, "kzn")).toBe(false);
    expect(adminCities(mskAdmin)).toEqual(["msk"]);
  });

  test("an organizer may raise events in their branch but not run it", () => {
    expect(canCreateEventIn(kznOrganizer, "kzn")).toBe(true);
    expect(canAdminCity(kznOrganizer, "kzn")).toBe(false);
    expect(canCreateEventIn(kznOrganizer, "msk")).toBe(false);
    expect(organizerCities(kznOrganizer)).toEqual(["kzn"]);
    expect(adminCities(kznOrganizer)).toEqual([]);
  });

  test("someone with no hold anywhere may do nothing", () => {
    expect(canCreateEventIn(nobody, "spb")).toBe(false);
    expect(adminCities(nobody)).toEqual([]);
    expect(organizerCities(nobody)).toEqual([]);
  });

  test("every branch keeps Moscow time for now", () => {
    for (const city of ["spb", "msk", "kzn"] as const) expect(timezoneOf(city)).toBe("Europe/Moscow");
  });
});

describe("granting a role", () => {
  const general = actorOf(true);
  const mskAdmin = actorOf(false, [["msk", "admin"]]);
  const mskOrganizer = actorOf(false, [["msk", "organizer"]]);

  test("a general admin may appoint anyone anywhere, branch admins included", () => {
    expect(canGrantRole(general, "kzn", "admin", null)).toBe(true);
    expect(canGrantRole(general, "kzn", null, "admin")).toBe(true);
  });

  test("a branch admin appoints organizers in their own branch only", () => {
    expect(canGrantRole(mskAdmin, "msk", "organizer", null)).toBe(true);
    expect(canGrantRole(mskAdmin, "msk", null, "organizer")).toBe(true);
    expect(canGrantRole(mskAdmin, "spb", "organizer", null)).toBe(false);
  });

  test("a branch admin can neither mint a peer nor unseat one", () => {
    expect(canGrantRole(mskAdmin, "msk", "admin", null)).toBe(false);
    expect(canGrantRole(mskAdmin, "msk", "organizer", "admin")).toBe(false);
    expect(canGrantRole(mskAdmin, "msk", null, "admin")).toBe(false);
  });

  test("an organizer appoints nobody", () => {
    expect(canGrantRole(mskOrganizer, "msk", "organizer", null)).toBe(false);
  });
});

describe("running an event", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db);
    seedUser(db, 1);
    seedUser(db, 7);
    seedEvent(db, 1, "msk");
    seedEvent(db, 2, "kzn");
  });

  test("whoever runs the branch runs its events", () => {
    const actor = actorOf(false, [["msk", "admin"]]);
    expect(canManageEvent(db, actor, { id: 1, city: "msk" })).toBe(true);
    expect(canManageEvent(db, actor, { id: 2, city: "kzn" })).toBe(false);
  });

  test("being named on an event is enough on its own, with no branch role behind it", () => {
    // The pre-cities arrangement: an organizer row and nothing else.
    db.$client.query("INSERT INTO event_organizers (event_id, user_id) VALUES (2, 7)").run();
    expect(canManageEvent(db, actorOf(false), { id: 2, city: "kzn" })).toBe(true);
    expect(canManageEvent(db, actorOf(false), { id: 1, city: "msk" })).toBe(false);
  });

  test("an organizer role alone does not hand over the branch's other events", () => {
    expect(canManageEvent(db, actorOf(false, [["kzn", "organizer"]]), { id: 2, city: "kzn" })).toBe(false);
  });

  test("loadActor reads the holds off the table", () => {
    db.insert(userCityRoles).values([
      { city: "msk", userId: 7, role: "admin" },
      { city: "kzn", userId: 7, role: "organizer" },
    ]).run();
    const actor = loadActor(db, 7, false);
    expect(actor.roles.get("msk")).toBe("admin");
    expect(actor.roles.get("kzn")).toBe("organizer");
    expect(actor.roles.get("spb")).toBeUndefined();
    expect(adminCities(actor)).toEqual(["msk"]);
    expect(organizerCities(actor)).toEqual(["msk", "kzn"]);
  });
});

describe("what a runner browses", () => {
  let db: Db;
  const listFor = (city: "spb" | "msk" | "kzn", userId: number) =>
    db.select({ id: events.id }).from(events)
      .where(and(eq(events.status, "published"), isNull(events.endedAt), inCityForUser(city, userId)))
      .orderBy(asc(events.id)).all().map((row) => row.id);

  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db);
    seedUser(db, 1);
    seedUser(db, 42);
    seedEvent(db, 1, "spb");
    seedEvent(db, 2, "msk");
    seedEvent(db, 3, "kzn");
  });

  test("only the chosen branch's runs", () => {
    expect(listFor("spb", 42)).toEqual([1]);
    expect(listFor("msk", 42)).toEqual([2]);
  });

  test("a run you hold a spot at follows you home", () => {
    db.$client.query("INSERT INTO registrations (event_id, user_id, status) VALUES (2, 42, 'registered')").run();
    expect(listFor("spb", 42)).toEqual([1, 2]);
  });

  test("a spot you gave up does not", () => {
    db.$client.query("INSERT INTO registrations (event_id, user_id, status) VALUES (2, 42, 'canceled')").run();
    expect(listFor("spb", 42)).toEqual([1]);
  });

  test("someone else's spot is not yours to see", () => {
    db.$client.query("INSERT INTO registrations (event_id, user_id, status) VALUES (2, 1, 'registered')").run();
    expect(listFor("spb", 42)).toEqual([1]);
  });
});
