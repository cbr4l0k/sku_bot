import { beforeEach, describe, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";
import { endEvent } from "../../src/core/waitlist";
import { joinEvent } from "../../src/core/registration";
import { mintTicketToken, scanTicket, toggleHandover, turnIn, verifyTicketToken } from "../../src/core/checkin";
import { run } from "../support/effect";

let db: Db;
const now = new Date("2030-01-01T12:00:00Z");
const unix = (date: Date) => Math.floor(date.getTime() / 1000);

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  for (let id = 1; id <= 4; id++) db.$client.query("INSERT INTO users (id, first_name) VALUES (?, ?)").run(id, `U${id}`);
  db.$client
    .query("INSERT INTO events (id, title, description, starts_at, location, capacity, status, created_by) VALUES (1, 'run', 'x', ?, 'park', 10, 'published', 1)")
    .run(unix(new Date(now.getTime() + 3_600_000)));
});

/** A settled purchase with one merch line, as the door would find it. */
const purchase = (userId: number, name = "hoodie", quantity = 1) => {
  const orderId = `order-${userId}-${name}`;
  db.$client
    .query("INSERT INTO ticket_orders (id, event_id, user_id, ticket_name, amount_minor, status, expires_at) VALUES (?, 1, ?, 'Standard', 5000, 'fulfilled', ?)")
    .run(orderId, userId, unix(now));
  db.$client
    .query("INSERT INTO order_items (order_id, kind, name, unit_amount_minor, quantity) VALUES (?, 'merchandise', ?, 5000, ?)")
    .run(orderId, name, quantity);
  return db.$client.query<{ id: number }, [string]>("SELECT id FROM order_items WHERE order_id = ?").get(orderId)!.id;
};

const handedOver = (itemId: number) =>
  db.$client.query<{ handed_over_at: number | null; handed_over_by: number | null }, [number]>(
    "SELECT handed_over_at, handed_over_by FROM order_items WHERE id = ?",
  ).get(itemId);

describe("runner-held tickets", () => {
  test("a ticket binds one person to one event and survives tampering", () => {
    const token = mintTicketToken("secret", 1, 7);
    expect(verifyTicketToken("secret", token)).toEqual({ eventId: 1, userId: 7 });
    expect(verifyTicketToken("other", token)).toBeNull();
    // Swapping the identity in a ticket someone else's signature covers.
    expect(verifyTicketToken("secret", token.replace(".7.", ".8."))).toBeNull();
    expect(verifyTicketToken("secret", "skutkt.1.7.short")).toBeNull();
    expect(verifyTicketToken("secret", mintTicketToken("secret", 2, 7))).toEqual({ eventId: 2, userId: 7 });
  });

  test("the ticket does not rotate, so an offline runner is never turned away", () => {
    const early = mintTicketToken("secret", 1, 1);
    expect(mintTicketToken("secret", 1, 1)).toBe(early);
    expect(verifyTicketToken("secret", early)).toEqual({ eventId: 1, userId: 1 });
  });

  test("scanning checks the runner in, and a second scan reports rather than refuses", () => {
    run(db, joinEvent(1, 1, now));
    const first = run(db, scanTicket(1, 1, now));
    expect(first).toEqual({ ok: true, alreadyCheckedIn: false, checkedInAt: now });

    const later = new Date(now.getTime() + 60_000);
    const second = run(db, scanTicket(1, 1, later));
    // Still an answer with the person's details behind it — and it names the
    // moment the ticket was actually burned, not the moment it was re-shown.
    expect(second).toEqual({ ok: true, alreadyCheckedIn: true, checkedInAt: now });
  });

  test("a ticket for someone who never registered, or an ended event, is refused", () => {
    expect(run(db, scanTicket(1, 3, now))).toEqual({ error: "not_registered" });
    run(db, joinEvent(1, 2, now));
    run(db, endEvent(1, now));
    expect(run(db, scanTicket(1, 2, now))).toEqual({ error: "event_over" });
  });

  test("a waitlisted runner cannot walk in on a ticket", () => {
    db.$client.query("UPDATE events SET capacity = 1 WHERE id = 1").run();
    run(db, joinEvent(1, 1, now));
    run(db, joinEvent(1, 2, now));
    expect(run(db, scanTicket(1, 2, now))).toEqual({ error: "not_registered" });
  });
});

describe("merch handover", () => {
  test("a line toggles, and records who handed it over", () => {
    run(db, joinEvent(1, 1, now));
    const itemId = purchase(1);

    expect(run(db, toggleHandover(1, itemId, 2, now))).toEqual({ handedOverAt: now });
    expect(handedOver(itemId)).toEqual({ handed_over_at: unix(now), handed_over_by: 2 });

    // The commonest correction at a busy counter is an undo.
    expect(run(db, toggleHandover(1, itemId, 2, now))).toEqual({ handedOverAt: null });
    expect(handedOver(itemId)).toEqual({ handed_over_at: null, handed_over_by: null });
  });

  test("lines are independent, and belong to the event that sold them", () => {
    run(db, joinEvent(1, 1, now));
    const hoodie = purchase(1, "hoodie");
    const cap = purchase(1, "cap", 2);

    run(db, toggleHandover(1, hoodie, 2, now));
    expect(handedOver(hoodie)?.handed_over_at).toBe(unix(now));
    expect(handedOver(cap)?.handed_over_at).toBeNull();

    // Another event's organizer cannot reach into this one's counter.
    expect(run(db, toggleHandover(2, hoodie, 3, now))).toEqual({ error: "item_not_found" });
    expect(run(db, toggleHandover(1, 9999, 3, now))).toEqual({ error: "item_not_found" });
  });

  test("the seat itself is not a merch line", () => {
    run(db, joinEvent(1, 1, now));
    db.$client
      .query("INSERT INTO ticket_orders (id, event_id, user_id, ticket_name, amount_minor, status, expires_at) VALUES ('seat', 1, 1, 'Standard', 5000, 'fulfilled', ?)")
      .run(unix(now));
    db.$client
      .query("INSERT INTO order_items (order_id, kind, name, unit_amount_minor, quantity) VALUES ('seat', 'ticket', 'Standard', 5000, 1)")
      .run();
    const seat = db.$client.query<{ id: number }, []>("SELECT id FROM order_items WHERE order_id = 'seat'").get()!.id;
    expect(run(db, toggleHandover(1, seat, 2, now))).toEqual({ error: "item_not_found" });
  });
});

describe("staff turning in", () => {
  const staffRow = (userId: number) => db.$client
    .query("INSERT INTO registrations (event_id, user_id, status, is_staff) VALUES (1, ?, 'registered', 1)")
    .run(userId);
  const row = (userId: number) => db.$client
    .query<{ status: string; checkin_method: string | null; checked_in_at: number | null }, [number]>(
      "SELECT status, checkin_method, checked_in_at FROM registrations WHERE event_id = 1 AND user_id = ?",
    ).get(userId);

  test("staff check themselves in without a scan, once", () => {
    staffRow(1);
    expect(run(db, turnIn(1, 1, now))).toEqual({ ok: true });
    expect(row(1)).toEqual({ status: "checked_in", checkin_method: "manual", checked_in_at: unix(now) });
    expect(run(db, turnIn(1, 1, now))).toEqual({ error: "already_checked_in" });
  });

  test("runners and strangers cannot turn in, and nobody can after the end", () => {
    run(db, joinEvent(1, 2, now));
    expect(run(db, turnIn(1, 2, now))).toEqual({ error: "not_staff" });
    expect(row(2)?.status).toBe("registered");
    expect(run(db, turnIn(1, 3, now))).toEqual({ error: "not_registered" });
    staffRow(4);
    run(db, endEvent(1, now));
    expect(run(db, turnIn(1, 4, now))).toEqual({ error: "event_over" });
  });
});
