import { CITIES, cities, type CityRole, type CitySlug } from "@sku/cities";
import { and, eq, eventOrganizers, events, sql, userCityRoles, type Db } from "@sku/db";

/**
 * The runs a person browses: their own branch's, plus anything they already hold a
 * live spot at. The second branch mirrors the grandfathered-registrant clause in
 * `visibleToUser` — someone who signed up for a run in another city while visiting
 * must not lose sight of it (and with it the cancel button) the moment they switch
 * back home.
 *
 * This is a browsing filter and nothing more. A deep link to another branch's run
 * still resolves, and joining it still works; only the list narrows.
 */
export const inCityForUser = (city: CitySlug, userId: number) => sql`(
  ${events.city} = ${city}
  OR EXISTS (
    SELECT 1 FROM registrations
    WHERE registrations.event_id = ${events.id} AND registrations.user_id = ${userId}
      AND registrations.status <> 'canceled'
  )
)`;

/* --------------------------------------------------------------- the ladder */

/**
 * Who is asking, and what they may do. Resolved once per request in `api/auth.ts`
 * so handlers can decide without going back to the database.
 *
 * `isGlobalAdmin` is the old `users.is_admin` bit plus the ADMIN_IDS floor, and it
 * still means the whole club. Everything else is one branch at a time.
 */
export type Actor = {
  userId: number;
  isGlobalAdmin: boolean;
  roles: ReadonlyMap<CitySlug, CityRole>;
};

export const loadActor = (db: Db, userId: number, isGlobalAdmin: boolean): Actor => ({
  userId,
  isGlobalAdmin,
  roles: new Map(
    db.select({ city: userCityRoles.city, role: userCityRoles.role })
      .from(userCityRoles)
      .where(eq(userCityRoles.userId, userId))
      .all()
      .map((row) => [row.city, row.role] as const),
  ),
});

/** Runs the branch: every power a general admin has, bounded to one city. */
export const canAdminCity = (actor: Actor, city: CitySlug): boolean =>
  actor.isGlobalAdmin || actor.roles.get(city) === "admin";

/** May raise a new run in the branch. Admins of it can too, by definition. */
export const canCreateEventIn = (actor: Actor, city: CitySlug): boolean =>
  canAdminCity(actor, city) || actor.roles.get(city) === "organizer";

/**
 * May run this event: anyone who administers its branch, or anyone named on the
 * event itself. The second clause deliberately accepts a bare `event_organizers`
 * row with no branch role behind it, so every organizer who existed before cities
 * did keeps working untouched.
 */
export const canManageEvent = (db: Db, actor: Actor, event: { id: number; city: CitySlug }): boolean =>
  canAdminCity(actor, event.city) || Boolean(
    db.select({ eventId: eventOrganizers.eventId })
      .from(eventOrganizers)
      .where(and(eq(eventOrganizers.eventId, event.id), eq(eventOrganizers.userId, actor.userId)))
      .get(),
  );

/** The branches this actor runs — every city for a general admin. */
export const adminCities = (actor: Actor): CitySlug[] =>
  actor.isGlobalAdmin ? [...cities] : cities.filter((city) => actor.roles.get(city) === "admin");

/** The branches this actor may raise events in. */
export const organizerCities = (actor: Actor): CitySlug[] =>
  actor.isGlobalAdmin ? [...cities] : cities.filter((city) => actor.roles.has(city));

/**
 * Whether `actor` may set `role` on someone else in `city`. A general admin may
 * set anything anywhere. A branch admin may only appoint and unappoint organizers
 * in their own branch — minting a peer, or unseating one, stays with the club.
 */
export const canGrantRole = (actor: Actor, city: CitySlug, role: CityRole | null, targetCurrent: CityRole | null): boolean => {
  if (actor.isGlobalAdmin) return true;
  if (actor.roles.get(city) !== "admin") return false;
  return role !== "admin" && targetCurrent !== "admin";
};

/** The event's own zone, so a run reads at the time it actually starts. */
export const timezoneOf = (city: CitySlug): string => CITIES[city].timezone;
