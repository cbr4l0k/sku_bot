import { cities, type CityRole, type CitySlug } from "@sku/cities";
import { and, eq, userCityRoles, users, type Db } from "@sku/db";

import { canGrantRole, type Actor } from "./cities";

/**
 * The person card an admin opens from People: who they are, what they have done
 * for the club, and what they hold in each branch.
 */

const rolesOf = (db: Db, userId: number): Map<CitySlug, CityRole> => new Map(
  db.select({ city: userCityRoles.city, role: userCityRoles.role }).from(userCityRoles)
    .where(eq(userCityRoles.userId, userId)).all()
    .map((row) => [row.city, row.role] as const),
);

/**
 * Every branch, held or not, with the values this actor may set it to. A branch
 * the actor cannot touch comes back with an empty list rather than being left
 * out, so the card can still show what the person holds there.
 */
const branchRoles = (actor: Actor, held: ReadonlyMap<CitySlug, CityRole>) => cities.map((city) => {
  const role = held.get(city) ?? null;
  const options: (CityRole | null)[] = [null, "organizer", "admin"];
  return { city, role, grantable: options.filter((option) => canGrantRole(actor, city, option, role)) };
});

/**
 * Sign-ups are spots they ever held (not canceled, not staff). Turnout matches the
 * runner's own profile: check-ins over spots held at runs their organizers have
 * ended. "Led" counts runs they were named on that actually went ahead.
 */
const record = (db: Db, userId: number) => {
  const runs = db.$client.query<{ sign_ups: number; ran: number | null; held: number | null }, [number]>(`
    SELECT count(*) AS sign_ups,
      sum(e.ended_at IS NOT NULL AND r.status = 'checked_in') AS ran,
      sum(e.ended_at IS NOT NULL AND r.status IN ('registered', 'checked_in')) AS held
    FROM registrations r JOIN events e ON e.id = r.event_id
    WHERE r.user_id = ? AND r.is_staff = 0 AND r.status <> 'canceled'
  `).get(userId);
  const led = db.$client.query<{ led: number }, [number]>(`
    SELECT count(*) AS led FROM event_organizers o JOIN events e ON e.id = o.event_id
    WHERE o.user_id = ? AND e.status IN ('published', 'closed')
  `).get(userId)?.led ?? 0;
  const held = runs?.held ?? 0;
  return { signUps: runs?.sign_ups ?? 0, turnout: held > 0 ? (runs?.ran ?? 0) / held : null, led };
};

export const personCard = (db: Db, actor: Actor, userId: number, configuredAdminIds: ReadonlySet<number>) => {
  const person = db.select().from(users).where(eq(users.id, userId)).get();
  if (!person) return null;
  return {
    id: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    username: person.username,
    // As stored; masking is the client's choice, and admins already see it in the list.
    phone: person.phone,
    joinedAt: person.createdAt.toISOString(),
    isAdmin: person.isAdmin || configuredAdminIds.has(person.id),
    isConfiguredAdmin: configuredAdminIds.has(person.id),
    isBanned: person.isBanned,
    stats: record(db, person.id),
    roles: branchRoles(actor, rolesOf(db, person.id)),
    // Blocking reaches every branch at once, so it stays with the club (as the ban route enforces).
    canBlock: actor.isGlobalAdmin,
  };
};

/**
 * The card's Save: every branch at once, all or nothing. Each change is checked
 * against `canGrantRole` before anything is written, so a branch admin who also
 * submits a branch they do not run gets a refusal, not half a save.
 *
 * Returns the branches whose role actually changed, for re-syncing their rosters.
 */
export const setCityRoles = (
  db: Db,
  actor: Actor,
  userId: number,
  changes: readonly { city: CitySlug; role: CityRole | null }[],
): { changed: CitySlug[] } | { error: "forbidden" | "duplicate_city" } => {
  if (new Set(changes.map((change) => change.city)).size !== changes.length) return { error: "duplicate_city" };
  const held = rolesOf(db, userId);
  const effective = changes.filter((change) => (held.get(change.city) ?? null) !== change.role);
  if (effective.some((change) => !canGrantRole(actor, change.city, change.role, held.get(change.city) ?? null))) {
    return { error: "forbidden" };
  }
  db.$client.transaction(() => {
    for (const { city, role } of effective) {
      if (role === null) {
        db.delete(userCityRoles).where(and(eq(userCityRoles.city, city), eq(userCityRoles.userId, userId))).run();
      } else {
        db.insert(userCityRoles).values({ city, userId, role })
          .onConflictDoUpdate({ target: [userCityRoles.city, userCityRoles.userId], set: { role } }).run();
      }
    }
  })();
  return { changed: effective.map((change) => change.city) };
};
