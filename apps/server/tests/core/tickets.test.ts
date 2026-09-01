import { beforeEach, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";

import {
  createCheckout,
  reconcilePayment,
  refundCanceledEvent,
  sweepTicketPayments,
} from "../../src/core/tickets";
import type {
  PaymentProvider,
  ProviderPayment,
  ProviderPaymentStatus,
  ProviderRefund,
} from "../../src/payments/provider";

class FakeProvider implements PaymentProvider {
  readonly requiresCustomerContact = false;
  payments = new Map<string, ProviderPayment>();
  refunds = new Map<string, ProviderRefund>();
  createCalls = 0;
  createInputs: Array<Parameters<PaymentProvider["createPayment"]>[0]> = [];
  refundInputs: Array<Parameters<PaymentProvider["createRefund"]>[0]> = [];

  async createPayment(input: Parameters<PaymentProvider["createPayment"]>[0]) {
    this.createCalls += 1;
    this.createInputs.push(input);
    const existing = [...this.payments.values()].find((payment) => payment.metadata.idempotence_key === input.idempotenceKey);
    if (existing) return existing;
    const payment: ProviderPayment = {
      id: `pay-${this.payments.size + 1}`,
      status: "pending",
      amountMinor: input.amountMinor,
      currency: input.currency,
      metadata: { order_id: input.orderId, idempotence_key: input.idempotenceKey },
      confirmationUrl: `https://pay.example/${input.orderId}`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    this.payments.set(payment.id, payment);
    return payment;
  }

  async getPayment(paymentId: string) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error("payment missing");
    return payment;
  }

  async cancelPayment(paymentId: string) {
    return this.setPaymentStatus(paymentId, "canceled");
  }

  async createRefund(input: Parameters<PaymentProvider["createRefund"]>[0]) {
    this.refundInputs.push(input);
    const existing = [...this.refunds.values()].find((refund) => refund.metadata.idempotence_key === input.idempotenceKey);
    if (existing) return existing;
    const refund: ProviderRefund = {
      id: `refund-${this.refunds.size + 1}`,
      paymentId: input.paymentId,
      status: "succeeded",
      amountMinor: input.amountMinor,
      currency: input.currency,
      failureReason: null,
      metadata: { order_id: input.orderId, idempotence_key: input.idempotenceKey },
    };
    this.refunds.set(refund.id, refund);
    return refund;
  }

  async getRefund(refundId: string) {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error("refund missing");
    return refund;
  }

  setPaymentStatus(paymentId: string, status: ProviderPaymentStatus) {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error("payment missing");
    const updated = { ...payment, status };
    this.payments.set(paymentId, updated);
    return updated;
  }
}

let db: Db;
let provider: FakeProvider;
const now = new Date("2030-01-01T12:00:00Z");

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  provider = new FakeProvider();
  db.$client.exec(`
    INSERT INTO users (id, first_name, locale) VALUES (1, 'Runner', 'ru'), (2, 'Other', 'ru');
    INSERT INTO events (id, city, title, description, starts_at, location, capacity, status, created_by)
      VALUES (1, 'spb', 'Paid run', '', 1893499200, 'Park', 2, 'published', 1);
    INSERT INTO ticket_tiers (id, event_id, name, price_minor, quota, active, sort_order)
      VALUES (10, 1, 'Standard', 150000, 1, 1, 0);
    INSERT INTO event_products (id, event_id, kind, name, description, price_minor, stock, max_per_order, active, sort_order)
      VALUES (20, 1, 'merchandise', 'Club T-shirt / M', 'Pickup at event', 250000, 2, 2, 1, 0),
             (21, 1, 'addon', 'Photo pack', NULL, 50000, NULL, 1, 1, 1),
             (22, 1, 'merchandise', 'Variant T-shirt', 'Pickup at event', 250000, NULL, 2, 1, 2);
    INSERT INTO event_product_variants (id, product_id, name, stock, active, sort_order)
      VALUES (30, 22, 'M', 1, 1, 0), (31, 22, 'L', 2, 1, 1);
  `);
});

type ProductRequest = { productId: number; variantId?: number | null; quantity: number };
const checkout = (userId = 1, productItems: ProductRequest[] = []) => createCheckout(db, provider, {
  eventId: 1,
  tierId: 10,
  productItems,
  userId,
  returnUrl: "https://club.example/events/1",
}, now);

const merchCheckout = (userId = 1, productItems: ProductRequest[] = [{ productId: 20, quantity: 1 }]) => createCheckout(db, provider, {
  eventId: 1,
  tierId: null,
  productItems,
  userId,
  returnUrl: "https://club.example/events/1",
}, now);

test("checkout rejects a basket with neither a ticket nor a product", async () => {
  expect(await merchCheckout(1, [])).toEqual({ error: "invalid_basket" });
  expect(provider.createCalls).toBe(0);
});

test("checkout reserves inventory and only an authoritative succeeded payment issues one ticket", async () => {
  const first = await checkout();
  expect(first).not.toHaveProperty("error");
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM registrations").get()?.count).toBe(0);

  const repeated = await checkout();
  expect(repeated).toEqual(first);
  expect(provider.createCalls).toBe(1);

  provider.setPaymentStatus("pay-1", "succeeded");
  const reconciled = await reconcilePayment(db, provider, "pay-1", now);
  expect(reconciled.effects).toEqual([{ kind: "ticket_paid", userId: 1, eventId: 1 }]);
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM registrations WHERE user_id = 1").get()?.status).toBe("registered");
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM ticket_orders").get()?.status).toBe("fulfilled");

  expect((await reconcilePayment(db, provider, "pay-1", now)).effects).toEqual([]);
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM registrations").get()?.count).toBe(1);
});

test("one checkout reserves a ticket and multiple product lines and sends one server-priced receipt", async () => {
  db.$client.query("UPDATE ticket_tiers SET quota = NULL WHERE id = 10").run();
  const result = await checkout(1, [{ productId: 20, quantity: 2 }, { productId: 21, quantity: 1 }]);
  expect(result).not.toHaveProperty("error");
  expect(provider.createInputs[0]).toMatchObject({
    amountMinor: 700000,
    receiptItems: [
      { description: "Standard", quantity: 1, unitAmountMinor: 150000, paymentSubject: "service" },
      { description: "Club T-shirt / M", quantity: 2, unitAmountMinor: 250000, paymentSubject: "commodity" },
      { description: "Photo pack", quantity: 1, unitAmountMinor: 50000, paymentSubject: "service" },
    ],
  });
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM order_items").get()?.count).toBe(3);
  expect(await checkout(2, [{ productId: 20, quantity: 1 }])).toEqual({ error: "product_sold_out" });
});

test("merch can be paid for without a ticket and never creates an event registration", async () => {
  db.$client.query("DELETE FROM ticket_tiers").run();
  const checkoutResult = await merchCheckout(1, [{ productId: 20, quantity: 1 }, { productId: 21, quantity: 1 }]);
  expect(checkoutResult).not.toHaveProperty("error");
  expect(provider.createInputs[0]).toMatchObject({
    amountMinor: 300000,
    receiptItems: [
      { description: "Club T-shirt / M", quantity: 1, unitAmountMinor: 250000, paymentSubject: "commodity" },
      { description: "Photo pack", quantity: 1, unitAmountMinor: 50000, paymentSubject: "service" },
    ],
  });

  provider.setPaymentStatus("pay-1", "succeeded");
  expect((await reconcilePayment(db, provider, "pay-1", now)).effects).toEqual([
    { kind: "purchase_paid", userId: 1, eventId: 1 },
  ]);
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM registrations").get()?.count).toBe(0);
  expect(db.$client.query<{ status: string; ticket_tier_id: number | null }, []>(
    "SELECT status, ticket_tier_id FROM ticket_orders",
  ).get()).toEqual({ status: "fulfilled", ticket_tier_id: null });
});

test("a product with options requires one and reserves stock for the selected option only", async () => {
  expect(await merchCheckout(1, [{ productId: 22, quantity: 1 }])).toEqual({ error: "product_variant_required" });
  expect(await merchCheckout(1, [{ productId: 22, variantId: 999, quantity: 1 }])).toEqual({ error: "product_variant_not_found" });

  const medium = await merchCheckout(1, [{ productId: 22, variantId: 30, quantity: 1 }]);
  expect(medium).not.toHaveProperty("error");
  expect(provider.createInputs[0]?.receiptItems).toEqual([
    { description: "Variant T-shirt — M", quantity: 1, unitAmountMinor: 250000, paymentSubject: "commodity" },
  ]);
  expect(await merchCheckout(2, [{ productId: 22, variantId: 30, quantity: 1 }])).toEqual({ error: "product_sold_out" });
  expect(await merchCheckout(2, [{ productId: 22, variantId: 31, quantity: 1 }])).not.toHaveProperty("error");
});

test("a completed merch-only order does not block a later ticket purchase", async () => {
  await merchCheckout();
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);

  expect(await checkout()).not.toHaveProperty("error");
  expect(provider.createCalls).toBe(2);
});

test("merch-only reservations do not consume event ticket capacity", async () => {
  db.$client.query("UPDATE events SET capacity = 1").run();
  await merchCheckout(1);
  expect(await checkout(2)).not.toHaveProperty("error");
});

test("an active payment is reused only for the exact same basket", async () => {
  db.$client.query("UPDATE ticket_tiers SET quota = NULL WHERE id = 10").run();
  const first = await checkout(1, [{ productId: 20, quantity: 1 }]);
  expect(await checkout(1, [{ productId: 20, quantity: 1 }])).toEqual(first);
  expect(await checkout(1, [{ productId: 21, quantity: 1 }])).toEqual({ error: "active_order_exists" });
  expect(provider.createCalls).toBe(1);
});

test("a pending checkout consumes tier inventory and prevents overselling", async () => {
  expect(await checkout()).not.toHaveProperty("error");
  expect(await checkout(2)).toEqual({ error: "ticket_sold_out" });
});

test("provider amount tampering never creates a registration", async () => {
  await checkout();
  const payment = provider.payments.get("pay-1")!;
  provider.payments.set("pay-1", { ...payment, amountMinor: payment.amountMinor - 1, status: "succeeded" });
  await expect(reconcilePayment(db, provider, "pay-1", now)).rejects.toThrow("amount does not match");
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM registrations").get()?.count).toBe(0);
});

test("an expired pending payment is canceled remotely before inventory is released", async () => {
  await checkout();
  db.$client.query("UPDATE ticket_orders SET expires_at = ?").run(Math.floor(now.getTime() / 1000) - 1);
  await sweepTicketPayments(db, provider, now);
  expect(provider.payments.get("pay-1")?.status).toBe("canceled");
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM ticket_orders").get()?.status).toBe("canceled");
  expect(await checkout(2)).not.toHaveProperty("error");
});

test("canceling an event refunds every fulfilled order and only then cancels its registration", async () => {
  await checkout(1, [{ productId: 20, quantity: 2 }]);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  db.$client.query("UPDATE events SET status = 'canceled' WHERE id = 1").run();

  const effects = await refundCanceledEvent(db, provider, 1, now);
  expect(effects).toContainEqual({ kind: "ticket_refunded", userId: 1, eventId: 1 });
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM ticket_orders").get()?.status).toBe("refunded");
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM registrations").get()?.status).toBe("canceled");
  expect(provider.refundInputs[0]).toMatchObject({
    amountMinor: 650000,
    receiptItems: [
      { description: "Standard", quantity: 1, unitAmountMinor: 150000 },
      { description: "Club T-shirt / M", quantity: 2, unitAmountMinor: 250000 },
    ],
  });
});

test("event cancellation refunds a merch-only order without changing registration state", async () => {
  db.$client.query("DELETE FROM ticket_tiers").run();
  db.$client.query("INSERT INTO registrations (event_id, user_id, status) VALUES (1, 1, 'registered')").run();
  await merchCheckout();
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  db.$client.query("UPDATE events SET status = 'canceled' WHERE id = 1").run();

  const effects = await refundCanceledEvent(db, provider, 1, now);
  expect(effects).toContainEqual({ kind: "purchase_refunded", userId: 1, eventId: 1 });
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM registrations").get()?.status).toBe("registered");
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM ticket_orders").get()?.status).toBe("refunded");
});

test("a payment that lands after cancellation is automatically refunded, never fulfilled", async () => {
  await checkout();
  db.$client.query("UPDATE ticket_orders SET status = 'cancel_pending'").run();
  provider.setPaymentStatus("pay-1", "succeeded");

  const result = await reconcilePayment(db, provider, "pay-1", now);
  expect(result.effects).toContainEqual({ kind: "ticket_refunded", userId: 1, eventId: 1 });
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM registrations").get()?.count).toBe(0);
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM ticket_orders").get()?.status).toBe("refunded");
});
