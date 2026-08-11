import { and, asc, chatMembers, eq, eventChats, events, gt, inArray, sql, type Db } from "@sku/db";

/**
 * Membership lives in Telegram, so every answer is a getChatMember call. The
 * event queries filter in SQL, so answers are cached in `chat_members` and
 * refreshed on read once this old.
 */
export const MEMBERSHIP_TTL_MS = 5 * 60 * 1000;

/** Whether the user is currently in the chat; null when Telegram could not answer. */
export type MembershipProbe = (chatId: number, userId: number) => Promise<boolean | null>;

/**
 * An event with no chats is open to everyone; one with chats is visible only to
 * members of at least one of them.
 *
 * Anyone already holding a live registration keeps seeing the event, so a
 * restriction added after the fact never strands them without a cancel button.
 */
export const visibleToUser = (userId: number) => sql`(
  NOT EXISTS (SELECT 1 FROM event_chats WHERE event_chats.event_id = ${events.id})
  OR EXISTS (
    SELECT 1 FROM event_chats
    JOIN chat_members ON chat_members.chat_id = event_chats.chat_id
    WHERE event_chats.event_id = ${events.id} AND chat_members.user_id = ${userId} AND chat_members.is_member = 1
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

export const chatsOfEvent = (db: Db, eventId: number): number[] => db
  .select({ chatId: eventChats.chatId })
  .from(eventChats)
  .where(eq(eventChats.eventId, eventId))
  .orderBy(asc(eventChats.chatId))
  .all()
  .map((row) => row.chatId);

/** Every chat gating an event the participant list can show — the set worth refreshing. */
export const chatsGatingUpcomingEvents = (db: Db, now: Date): number[] => db
  .selectDistinct({ chatId: eventChats.chatId })
  .from(eventChats)
  .innerJoin(events, eq(events.id, eventChats.eventId))
  .where(and(eq(events.status, "published"), gt(events.startsAt, now)))
  .all()
  .map((row) => row.chatId);

export const setEventChats = (db: Db, eventId: number, chatIds: readonly number[]): number[] => {
  const unique = [...new Set(chatIds)].sort((a, b) => a - b);
  db.$client.transaction(() => {
    db.delete(eventChats).where(eq(eventChats.eventId, eventId)).run();
    for (const chatId of unique) db.insert(eventChats).values({ eventId, chatId }).run();
  })();
  return unique;
};

/** Brings the user's cached answers for `chatIds` up to date, asking Telegram only where stale. */
export const refreshMemberships = async (
  db: Db,
  probe: MembershipProbe,
  userId: number,
  chatIds: readonly number[],
  now: Date,
): Promise<void> => {
  const unique = [...new Set(chatIds)];
  if (unique.length === 0) return;

  const cached = new Map(
    db.select().from(chatMembers)
      .where(and(eq(chatMembers.userId, userId), inArray(chatMembers.chatId, unique)))
      .all()
      .map((row) => [row.chatId, row] as const),
  );
  const stale = unique.filter((chatId) => {
    const row = cached.get(chatId);
    return !row || now.getTime() - row.checkedAt.getTime() >= MEMBERSHIP_TTL_MS;
  });
  if (stale.length === 0) return;

  const answers = await Promise.all(stale.map(async (chatId) => [chatId, await probe(chatId, userId)] as const));
  for (const [chatId, isMember] of answers) {
    // A failed lookup keeps whatever was known and stays stale so the next read retries.
    // With nothing known we record "not a member", so an unreachable chat closes an
    // event rather than opening it to everyone.
    if (isMember === null && cached.has(chatId)) continue;
    db.insert(chatMembers)
      .values({ chatId, userId, isMember: isMember ?? false, checkedAt: now })
      .onConflictDoUpdate({
        target: [chatMembers.chatId, chatMembers.userId],
        set: { isMember: isMember ?? false, checkedAt: now },
      })
      .run();
  }
};
