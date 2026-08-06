import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import { acceptOffer, setCapacity, sweepOffers } from "../../src/core/waitlist";
import { cancelRegistration, joinEvent } from "../../src/core/registration";
import { checkIn, manualToggleCheckin, mintCheckinToken, verifyCheckinToken } from "../../src/core/checkin";
import { botEventLink, eventStartappPayload, miniAppEventLink, parseStartPayload } from "../../src/core/links";
import { eventStats, globalStats } from "../../src/core/stats";

let db: Db;
const now = new Date("2030-01-01T12:00:00Z");
const unix = (date: Date) => Math.floor(date.getTime() / 1000);
beforeEach(() => { db = createDb(":memory:"); migrate(db); for (let id = 1; id <= 8; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`); });
const event = (capacity: number | null, id = 1) => { db.$client.query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, created_by) VALUES (?, 'run', 'x', ?, 'park', ?, 'published', 1)").run(id, unix(new Date(now.getTime() + 86_400_000)), capacity); return id; };
const offers = () => db.$client.query<{ id: number; user_id: number; status: string; expires_at: number }, []>("SELECT id, user_id, status, expires_at FROM waitlist_offers ORDER BY id").all();

describe("waitlist engine", () => {
  test("joins until full and derives waitlist positions", () => { event(2); expect(joinEvent(db, 1, 1, now)).toEqual({ status: "registered" }); expect(joinEvent(db, 1, 2, now)).toEqual({ status: "registered" }); expect(joinEvent(db, 1, 3, now)).toEqual({ status: "waitlisted", position: 1 }); expect(joinEvent(db, 1, 4, now)).toEqual({ status: "waitlisted", position: 2 }); });
  test("cancel issues an offer to the waitlist head", () => { event(1); joinEvent(db, 1, 1, now); joinEvent(db, 1, 2, now); joinEvent(db, 1, 3, now); const result = cancelRegistration(db, 1, 1, now); expect(result.effects).toHaveLength(1); expect(offers()[0]?.user_id).toBe(2); });
  test("expiry cascades without superseding the original offer", () => { event(1); joinEvent(db, 1, 1, now); joinEvent(db, 1, 2, now); joinEvent(db, 1, 3, now); cancelRegistration(db, 1, 1, now); const first = offers()[0]!; const effects = sweepOffers(db, new Date((first.expires_at + 1) * 1000)); expect(effects[0]?.userId).toBe(3); expect(offers()[0]?.status).toBe("pending"); expect(offers()).toHaveLength(2); });
  test("expired offers remain FCFS claimable and a filled event supersedes others", () => { event(1); joinEvent(db, 1, 1, now); joinEvent(db, 1, 2, now); joinEvent(db, 1, 3, now); cancelRegistration(db, 1, 1, now); const first = offers()[0]!; sweepOffers(db, new Date((first.expires_at + 1) * 1000)); const second = offers()[1]!; const firstResult = acceptOffer(db, first.id, 2, new Date((first.expires_at + 2) * 1000)); expect(firstResult).toMatchObject({ ok: true, effects: [{ kind: "offer_superseded", offerId: second.id }] }); expect(acceptOffer(db, second.id, 3, now)).toEqual({ ok: false, reason: "spot_taken" }); });
  test("capacity increase issues offers and rejoin goes to tail", () => { event(1); joinEvent(db, 1, 1, now); joinEvent(db, 1, 2, now); joinEvent(db, 1, 3, now); cancelRegistration(db, 1, 2, now); expect(joinEvent(db, 1, 2, new Date(now.getTime() + 1000))).toEqual({ status: "waitlisted", position: 2 }); expect(setCapacity(db, 1, 2, now)[0]?.userId).toBe(3); });
});

test("check-in tokens, manual toggle, links, and stats", () => { event(3); joinEvent(db, 1, 1, now); const token = mintCheckinToken("secret", 1, now); expect(verifyCheckinToken("secret", token, new Date(now.getTime() + 50_000))).toEqual({ eventId: 1 }); expect(verifyCheckinToken("secret", `${token}x`, now)).toBeNull(); expect(checkIn(db, 1, 1, now)).toEqual({ ok: true }); expect(manualToggleCheckin(db, 1, 1, now)).toEqual({ status: "registered" }); expect(eventStats(db, 1)).toMatchObject({ registered: 1, waitlisted: 0, checkedIn: 0, offersMade: 0 }); expect(globalStats(db)).toMatchObject({ totalEvents: 1, uniqueParticipants: 1 }); expect(parseStartPayload(eventStartappPayload(12))).toEqual({ type: "event", eventId: 12 }); expect(parseStartPayload("evt_01")).toBeNull(); expect(miniAppEventLink("bot", "app", 1)).toBe("https://t.me/bot/app?startapp=evt_1"); expect(botEventLink("bot", 1)).toBe("https://t.me/bot?start=evt_1"); });
