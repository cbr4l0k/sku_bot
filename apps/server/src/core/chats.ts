import { Effect } from "effect";
import type { CitySlug } from "@sku/cities";
import { asc, chats, eq } from "@sku/db";
import { Database } from "../services";

/**
 * The catalog of Telegram chats the club can point events at.
 *
 * A chat arrives here on its own: the bot files a row the moment it is added to a
 * group. That row is inert until a general admin says which branch it belongs to,
 * which is what makes self-registration safe — discovering a chat grants nothing.
 */

/** Files a chat the bot has just met. Never overwrites an assignment. */
export const rememberChat = Effect.fn("chats.rememberChat")(function* (chatId: number, title: string | null, now: Date) {
  const db = yield* Database;
  db.insert(chats)
    .values({ id: chatId, city: null, title, checkedAt: now })
    .onConflictDoUpdate({
      target: chats.id,
      // A title can change; which branch owns the chat is not ours to revise.
      set: { ...(title === null ? {} : { title }), problem: null, checkedAt: now },
    })
    .run();
});

/** Records what Telegram last said about a chat, for the admin UI's warning state. */
export const recordChatState = Effect.fn("chats.recordChatState")(function* (
  chatId: number,
  state: { title: string | null; problem: string | null },
  now: Date,
) {
  const db = yield* Database;
  db.update(chats)
    .set({ ...(state.title === null ? {} : { title: state.title }), problem: state.problem, checkedAt: now })
    .where(eq(chats.id, chatId))
    .run();
});

export const chatById = Effect.fnUntraced(function* (chatId: number) {
  const db = yield* Database;
  return db.select().from(chats).where(eq(chats.id, chatId)).get();
});

/**
 * What an admin sees: every chat of the branches they run, plus every chat still
 * waiting to be filed. Unassigned chats are shown to general admins only — they
 * are the ones who may file them.
 */
export const chatCatalog = Effect.fnUntraced(function* (ownedCities: readonly CitySlug[], includeUnassigned: boolean) {
  const db = yield* Database;
  const owned = new Set(ownedCities);
  // A handful of rows at most — filtering here keeps the branch rule in one place.
  return db.select().from(chats).orderBy(asc(chats.city), asc(chats.id)).all()
    .filter((chat) => (chat.city === null ? includeUnassigned : owned.has(chat.city)));
});

/**
 * The chats an event in `city` may be gated to or funnelled into. A chat belongs
 * to exactly one branch, so a Kazan run can never reach into a Moscow group.
 */
export const assignableChats = Effect.fnUntraced(function* (city: CitySlug): Effect.fn.Return<number[], never, Database> {
  const db = yield* Database;
  return db.select({ id: chats.id }).from(chats).where(eq(chats.city, city)).orderBy(asc(chats.id)).all()
    .map((row) => row.id);
});

export const setChatCity = Effect.fn("chats.setChatCity")(function* (chatId: number, city: CitySlug | null) {
  const db = yield* Database;
  db.update(chats).set({ city }).where(eq(chats.id, chatId)).run();
});

/**
 * Lifts whatever is still listed in EVENT_GROUPS into the table, filed under the
 * branch that has been running everything so far. Mirrors `syncConfiguredAdmins`:
 * the env var stops being the source of truth but keeps working until it is
 * deleted, so no deploy has to be sequenced against this change.
 */
export const seedChatsFromEnv = Effect.fn("chats.seedChatsFromEnv")(function* (chatIds: readonly number[], city: CitySlug, now: Date) {
  const db = yield* Database;
  let seeded = 0;
  for (const id of chatIds) {
    const existing = db.select({ id: chats.id }).from(chats).where(eq(chats.id, id)).get();
    if (existing) continue;
    db.insert(chats).values({ id, city, checkedAt: now }).onConflictDoNothing().run();
    seeded += 1;
  }
  return seeded;
});
