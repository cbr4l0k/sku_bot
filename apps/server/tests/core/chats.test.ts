import { beforeEach, describe, expect, test } from "bun:test";
import { chats, createDb, eq, events, migrate, users, type Db } from "@sku/db";

import {
  assignableChats,
  chatById,
  chatCatalog,
  recordChatState,
  rememberChat,
  seedChatsFromEnv,
  setChatCity,
} from "../../src/core/chats";
import { migrateChat } from "../../src/core/membership";
import { run } from "../support/effect";

const now = new Date("2030-01-01T12:00:00Z");

describe("the chat catalog", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db);
  });

  test("a discovered chat arrives with no branch and is usable by nobody", () => {
    run(db, rememberChat(-100123, "Морозная набережная", now));
    const row = run(db, chatById(-100123));
    expect(row?.city).toBeNull();
    expect(row?.title).toBe("Морозная набережная");
    for (const city of ["spb", "msk", "kzn"] as const) expect(run(db, assignableChats(city))).toEqual([]);
  });

  test("filing it under a branch is what makes it usable, and only there", () => {
    run(db, rememberChat(-100123, "Чат", now));
    run(db, setChatCity(-100123, "msk"));
    expect(run(db, assignableChats("msk"))).toEqual([-100123]);
    expect(run(db, assignableChats("spb"))).toEqual([]);
  });

  test("meeting a chat again refreshes its name but never re-files it", () => {
    run(db, rememberChat(-100123, "Старое имя", now));
    run(db, setChatCity(-100123, "kzn"));
    run(db, rememberChat(-100123, "Новое имя", now));
    const row = run(db, chatById(-100123));
    expect(row?.title).toBe("Новое имя");
    expect(row?.city).toBe("kzn");
  });

  test("a nameless re-discovery keeps the name we already had", () => {
    run(db, rememberChat(-100123, "Имя", now));
    run(db, rememberChat(-100123, null, now));
    expect(run(db, chatById(-100123))?.title).toBe("Имя");
  });

  test("an unreachable chat records why, and recovers when it answers again", () => {
    run(db, rememberChat(-100123, "Чат", now));
    run(db, recordChatState(-100123, { title: null, problem: "Bad Request: chat not found" }, now));
    expect(run(db, chatById(-100123))?.problem).toBe("Bad Request: chat not found");
    run(db, recordChatState(-100123, { title: "Чат", problem: null }, now));
    expect(run(db, chatById(-100123))?.problem).toBeNull();
  });
});

describe("who sees which chats", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db);
    for (const [id, city] of [[-1, "spb"], [-2, "msk"], [-3, null]] as const) {
      run(db, rememberChat(id, `chat ${id}`, now));
      if (city) run(db, setChatCity(id, city));
    }
  });

  test("a general admin sees every branch's chats and the unfiled ones", () => {
    const seen = run(db, chatCatalog(["spb", "msk", "kzn"], true)).map((chat) => chat.id).sort((a, b) => a - b);
    expect(seen).toEqual([-3, -2, -1]);
  });

  test("a branch admin sees their own and is not shown chats waiting to be filed", () => {
    expect(run(db, chatCatalog(["msk"], false)).map((chat) => chat.id)).toEqual([-2]);
  });
});

describe("lifting EVENT_GROUPS into the table", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db);
  });

  test("anything still listed is filed under the default branch", () => {
    expect(run(db, seedChatsFromEnv([-1, -2], "spb", now))).toBe(2);
    expect(run(db, assignableChats("spb"))).toEqual([-2, -1]);
  });

  test("it never runs twice, and never overrides a branch already chosen", () => {
    run(db, seedChatsFromEnv([-1], "spb", now));
    run(db, setChatCity(-1, "kzn"));
    expect(run(db, seedChatsFromEnv([-1], "spb", now))).toBe(0);
    expect(run(db, chatById(-1))?.city).toBe("kzn");
  });
});

describe("a group upgraded to a supergroup", () => {
  let db: Db;
  beforeEach(() => {
    db = createDb(":memory:");
    migrate(db);
    db.insert(users).values({ id: 1, firstName: "u" }).run();
    run(db, rememberChat(-1, "Клуб", now));
    run(db, setChatCity(-1, "msk"));
    db.insert(events).values({
      id: 1, city: "msk", title: "e", description: "", startsAt: now,
      location: "park", status: "published", createdBy: 1, homeChatId: -1,
    }).run();
    db.$client.query("INSERT INTO event_chats (event_id, chat_id) VALUES (1, -1)").run();
    db.$client.query("INSERT INTO chat_members (chat_id, user_id, is_member, checked_at) VALUES (-1, 1, 1, 0)").run();
    db.$client.query("INSERT INTO chat_guests (chat_id, user_id, event_id, invite_link) VALUES (-1, 1, 1, 'x')").run();
  });

  test("the catalog row moves across, keeping its branch — no admin action needed", () => {
    run(db, migrateChat(-1, -1001));
    expect(run(db, chatById(-1))).toBeUndefined();
    expect(run(db, chatById(-1001))?.city).toBe("msk");
    expect(run(db, chatById(-1001))?.title).toBe("Клуб");
    expect(run(db, assignableChats("msk"))).toEqual([-1001]);
  });

  test("the restriction, the guest chat and the trials all follow it", () => {
    run(db, migrateChat(-1, -1001));
    expect(db.$client.query("SELECT chat_id FROM event_chats").all()).toEqual([{ chat_id: -1001 }]);
    expect(db.select({ home: events.homeChatId }).from(events).where(eq(events.id, 1)).get()?.home).toBe(-1001);
    expect(db.$client.query("SELECT chat_id FROM chat_guests").all()).toEqual([{ chat_id: -1001 }]);
    // Cached membership is dropped rather than moved: it was answered about a chat
    // that no longer exists and has to be asked again.
    expect(db.$client.query("SELECT chat_id FROM chat_members").all()).toEqual([]);
  });

  test("an upgrade onto a chat we already knew keeps the one that is there", () => {
    run(db, rememberChat(-1001, "Уже знаем", now));
    run(db, setChatCity(-1001, "kzn"));
    run(db, migrateChat(-1, -1001));
    expect(run(db, chatById(-1))).toBeUndefined();
    expect(run(db, chatById(-1001))?.city).toBe("kzn");
    expect(db.select().from(chats).all()).toHaveLength(1);
  });
});
