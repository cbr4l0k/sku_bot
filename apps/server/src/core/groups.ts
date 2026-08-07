import { and, asc, eq, eventGroups, events, sql, userGroups, type Db } from "@sku/db";

/**
 * An event carrying no group rows is open to everyone; one carrying groups is
 * visible and joinable only to users who belong to at least one of them.
 * Membership is plain data — dropping a name from EVENT_GROUPS stops it being
 * assignable but does not loosen events already restricted to it.
 *
 * Anyone already holding a live registration keeps seeing the event, so a
 * restriction added after the fact never strands them without a cancel button.
 */
export const visibleToUser = (userId: number) => sql`(
  NOT EXISTS (SELECT 1 FROM event_groups WHERE event_groups.event_id = ${events.id})
  OR EXISTS (
    SELECT 1 FROM event_groups
    JOIN user_groups ON user_groups.group_name = event_groups.group_name
    WHERE event_groups.event_id = ${events.id} AND user_groups.user_id = ${userId}
  )
  OR EXISTS (
    SELECT 1 FROM registrations
    WHERE registrations.event_id = ${events.id} AND registrations.user_id = ${userId}
      AND registrations.status <> 'canceled'
  )
)`;

export const canSeeEvent = (db: Db, eventId: number, userId: number): boolean => Boolean(
  db.select({ id: events.id }).from(events).where(and(eq(events.id, eventId), visibleToUser(userId))).get(),
);

export const groupsOfEvent = (db: Db, eventId: number): string[] => db
  .select({ groupName: eventGroups.groupName })
  .from(eventGroups)
  .where(eq(eventGroups.eventId, eventId))
  .orderBy(asc(eventGroups.groupName))
  .all()
  .map((row) => row.groupName);

export const groupsOfUser = (db: Db, userId: number): string[] => db
  .select({ groupName: userGroups.groupName })
  .from(userGroups)
  .where(eq(userGroups.userId, userId))
  .orderBy(asc(userGroups.groupName))
  .all()
  .map((row) => row.groupName);

export const setEventGroups = (db: Db, eventId: number, groups: readonly string[]): string[] => {
  const unique = [...new Set(groups)].sort();
  db.$client.transaction(() => {
    db.delete(eventGroups).where(eq(eventGroups.eventId, eventId)).run();
    for (const groupName of unique) db.insert(eventGroups).values({ eventId, groupName }).run();
  })();
  return unique;
};

export const setUserGroups = (db: Db, userId: number, groups: readonly string[]): string[] => {
  const unique = [...new Set(groups)].sort();
  db.$client.transaction(() => {
    db.delete(userGroups).where(eq(userGroups.userId, userId)).run();
    for (const groupName of unique) db.insert(userGroups).values({ userId, groupName }).run();
  })();
  return unique;
};
