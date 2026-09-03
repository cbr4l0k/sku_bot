import { beforeEach, expect, test } from "bun:test";
import { createDb, migrate, type Db } from "@sku/db";

import {
  cancelPendingOrder,
  createCheckout,
  ordersForEvent,
  ordersForUser,
  reconcilePayment,
  reconcileRefund,
  refundCanceledEvent,
  requestAdminRefund,
  requestUserRefund,
  sweepTicketPayments,
} from "../../src/core/tickets";
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderPaymentStatus,
  type ProviderRefund,
} from "../../src/payments/provider";

class FakeProvider implements PaymentProvider {
  readonly requiresCustomerContact = false;
  payments = new Map<string, ProviderPayment>();
  refunds = new Map<string, ProviderRefund>();
  createCalls = 0;
  createInputs: Array<Parameters<PaymentProvider["createPayment"]>[0]> = [];
  refundInputs: Array<Parameters<PaymentProvider["createRefund"]>[0]> = [];
  refundError: Error | null = null;

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

  async createRefund(input: Parameters<PaymentProvider["createRefund"]>[0]) {
    this.refundInputs.push(input);
    if (this.refundError) throw this.refundError;
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

  async getRefundsForPayment(paymentId: string) {
    return [...this.refunds.values()].filter((refund) => refund.paymentId === paymentId);
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

test("purchase history includes the event, basket lines, and payment controls", async () => {
  await checkout(1, [{ productId: 22, variantId: 31, quantity: 2 }]);

  expect(ordersForUser(db, 2)).toEqual([]);
  expect(ordersForUser(db, 1)).toMatchObject([{
    status: "awaiting_payment",
    confirmationUrl: expect.stringContaining("https://pay.example/"),
    amountMinor: 650000,
    currency: "RUB",
    event: { id: 1, title: "Paid run", status: "published" },
    items: [
      { kind: "ticket", name: "Standard", variantName: null, unitAmountMinor: 150000, quantity: 1 },
      { kind: "merchandise", name: "Variant T-shirt", variantName: "L", unitAmountMinor: 250000, quantity: 2 },
    ],
  }]);
});

test("admin event history includes ticket and merchandise-only orders with immutable basket details", async () => {
  const ticketOrder = await checkout(1, [{ productId: 21, quantity: 1 }]);
  if ("error" in ticketOrder) throw new Error(ticketOrder.error);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);

  const merchOrder = await merchCheckout(2, [{ productId: 20, quantity: 1 }]);
  if ("error" in merchOrder) throw new Error(merchOrder.error);
  provider.setPaymentStatus("pay-2", "succeeded");
  await reconcilePayment(db, provider, "pay-2", now);

  const history = ordersForEvent(db, 1);
  expect(history).toHaveLength(2);
  expect(history.find((order) => order.orderId === merchOrder.orderId)).toMatchObject({
    includesTicket: false,
    buyer: { userId: 2, firstName: "Other" },
    amountMinor: 250000,
    status: "fulfilled",
    refundable: true,
    items: [{ kind: "merchandise", name: "Club T-shirt / M", quantity: 1 }],
  });
  expect(history.find((order) => order.orderId === ticketOrder.orderId)).toMatchObject({
    includesTicket: true,
    buyer: { userId: 1, firstName: "Runner" },
    amountMinor: 200000,
    status: "fulfilled",
    refundable: true,
    items: [
      { kind: "ticket", name: "Standard", quantity: 1 },
      { kind: "addon", name: "Photo pack", quantity: 1 },
    ],
  });
});

test("admin can request a full refund for one specific event order", async () => {
  const checkoutResult = await checkout(1, [{ productId: 21, quantity: 1 }]);
  if ("error" in checkoutResult) throw new Error(checkoutResult.error);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);

  expect(await requestAdminRefund(db, provider, 999, checkoutResult.orderId, now)).toEqual({ error: "order_not_found" });
  expect(await requestAdminRefund(db, provider, 1, checkoutResult.orderId, now)).toMatchObject({
    effects: [{ kind: "ticket_refunded", userId: 1, eventId: 1 }],
  });
  expect(provider.refundInputs[0]).toMatchObject({
    orderId: checkoutResult.orderId,
    amountMinor: 200000,
    reason: "admin_requested",
  });
  expect(ordersForEvent(db, 1)[0]).toMatchObject({ status: "refunded", refundable: false });
  expect(await requestAdminRefund(db, provider, 1, checkoutResult.orderId, now)).toEqual({ error: "order_not_refundable" });
});

test("a definitive provider rejection fails the refund once and requires an explicit retry", async () => {
  const checkoutResult = await checkout();
  if ("error" in checkoutResult) throw new Error(checkoutResult.error);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  provider.refundError = new PaymentProviderError("YooKassa /refunds returned 403", 403, JSON.stringify({
    type: "error",
    code: "forbidden",
    description: "Refunds are restricted for this shop",
  }));

  expect(await requestAdminRefund(db, provider, 1, checkoutResult.orderId, now)).toEqual({
    effects: [{ kind: "ticket_refund_failed", userId: 1, eventId: 1 }],
  });
  expect(db.$client.query<{ status: string; failure_reason: string | null }, []>(
    "SELECT status, failure_reason FROM refunds",
  ).get()).toEqual({ status: "canceled", failure_reason: "Refunds are restricted for this shop" });
  expect(ordersForEvent(db, 1)[0]).toMatchObject({
    status: "refund_failed",
    refundFailureReason: "Refunds are restricted for this shop",
    refundable: true,
  });

  await sweepTicketPayments(db, provider, now);
  expect(provider.refundInputs).toHaveLength(1);

  provider.refundError = null;
  expect(await requestAdminRefund(db, provider, 1, checkoutResult.orderId, now)).toMatchObject({
    effects: [{ kind: "ticket_refunded", userId: 1, eventId: 1 }],
  });
  expect(provider.refundInputs).toHaveLength(2);
  expect(provider.refundInputs[1]?.idempotenceKey).not.toBe(provider.refundInputs[0]?.idempotenceKey);
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM refunds").get()?.count).toBe(2);
  expect(ordersForEvent(db, 1)[0]).toMatchObject({ status: "refunded", refundable: false });
});

test("the admin refund button reconciles a full refund already created in YooKassa", async () => {
  const checkoutResult = await checkout();
  if ("error" in checkoutResult) throw new Error(checkoutResult.error);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  provider.refundError = new PaymentProviderError("YooKassa /refunds returned 403", 403, JSON.stringify({
    code: "forbidden",
    description: "Refunds are restricted for this shop",
  }));
  await requestAdminRefund(db, provider, 1, checkoutResult.orderId, now);
  expect(provider.refundInputs).toHaveLength(1);

  provider.refundError = null;
  provider.refunds.set("dashboard-refund", {
    id: "dashboard-refund",
    paymentId: "pay-1",
    status: "succeeded",
    amountMinor: 150000,
    currency: "RUB",
    failureReason: null,
    metadata: {},
  });

  expect(await requestAdminRefund(db, provider, 1, checkoutResult.orderId, now)).toEqual({
    effects: [{ kind: "ticket_refunded", userId: 1, eventId: 1 }],
  });
  expect(provider.refundInputs).toHaveLength(1);
  expect(db.$client.query<{ provider_refund_id: string | null; status: string }, []>(
    "SELECT provider_refund_id, status FROM refunds",
  ).get()).toEqual({ provider_refund_id: "dashboard-refund", status: "succeeded" });
  expect(ordersForEvent(db, 1)[0]).toMatchObject({ status: "refunded", refundable: false });
});

test("the admin refund button refuses to overwrite a partial YooKassa refund", async () => {
  const checkoutResult = await checkout();
  if ("error" in checkoutResult) throw new Error(checkoutResult.error);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  provider.refunds.set("partial-refund", {
    id: "partial-refund",
    paymentId: "pay-1",
    status: "succeeded",
    amountMinor: 50000,
    currency: "RUB",
    failureReason: null,
    metadata: {},
  });

  await expect(requestAdminRefund(db, provider, 1, checkoutResult.orderId, now))
    .rejects.toThrow("already has a partial refund");
  expect(provider.refundInputs).toHaveLength(0);
  expect(ordersForEvent(db, 1)[0]).toMatchObject({ status: "fulfilled", refundable: true });
});

test("user cancellation reconciles a full refund already created in YooKassa", async () => {
  const checkoutResult = await checkout();
  if ("error" in checkoutResult) throw new Error(checkoutResult.error);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  provider.refunds.set("dashboard-refund", {
    id: "dashboard-refund",
    paymentId: "pay-1",
    status: "succeeded",
    amountMinor: 150000,
    currency: "RUB",
    failureReason: null,
    metadata: {},
  });

  expect(await requestUserRefund(db, provider, 1, 1, now)).toEqual([
    { kind: "ticket_refunded", userId: 1, eventId: 1 },
  ]);
  expect(provider.refundInputs).toHaveLength(0);
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM registrations").get()?.status).toBe("canceled");
  expect(ordersForEvent(db, 1)[0]).toMatchObject({ status: "refunded", refundable: false });
});

test("event cancellation reconciles a full refund already created in YooKassa", async () => {
  const checkoutResult = await checkout();
  if ("error" in checkoutResult) throw new Error(checkoutResult.error);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  provider.refunds.set("dashboard-refund", {
    id: "dashboard-refund",
    paymentId: "pay-1",
    status: "succeeded",
    amountMinor: 150000,
    currency: "RUB",
    failureReason: null,
    metadata: {},
  });
  db.$client.query("UPDATE events SET status = 'canceled' WHERE id = 1").run();

  expect(await refundCanceledEvent(db, provider, 1, now)).toEqual([
    { kind: "ticket_refunded", userId: 1, eventId: 1 },
  ]);
  expect(provider.refundInputs).toHaveLength(0);
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM registrations").get()?.status).toBe("canceled");
  expect(ordersForEvent(db, 1)[0]).toMatchObject({ status: "refunded", refundable: false });
});

test("a transient provider failure leaves the refund pending for the sweeper", async () => {
  const checkoutResult = await checkout();
  if ("error" in checkoutResult) throw new Error(checkoutResult.error);
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  provider.refundError = new PaymentProviderError("YooKassa /refunds returned 500", 500, "temporary failure");

  await expect(requestAdminRefund(db, provider, 1, checkoutResult.orderId, now)).rejects.toThrow("returned 500");
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM refunds").get()?.status).toBe("pending");
  expect(ordersForEvent(db, 1)[0]?.status).toBe("refund_pending");

  provider.refundError = null;
  await sweepTicketPayments(db, provider, now);
  expect(provider.refundInputs).toHaveLength(2);
  expect(ordersForEvent(db, 1)[0]?.status).toBe("refunded");
});

test("a user can abandon an unfinished basket and immediately start another checkout", async () => {
  const result = await checkout();
  if ("error" in result) throw new Error(result.error);

  expect(await cancelPendingOrder(db, result.orderId, 2, now)).toEqual({ error: "order_not_found" });
  expect(await cancelPendingOrder(db, result.orderId, 1, now)).toMatchObject({
    status: "cancel_pending",
    confirmationUrl: null,
  });
  expect(provider.payments.get("pay-1")?.status).toBe("pending");

  const replacement = await checkout(1, [{ productId: 21, quantity: 1 }]);
  expect(replacement).not.toHaveProperty("error");
  expect(replacement).not.toMatchObject({ orderId: result.orderId });
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

test("an expired pending payment is abandoned locally without calling unsupported remote cancellation", async () => {
  await checkout();
  db.$client.query("UPDATE ticket_orders SET expires_at = ?").run(Math.floor(now.getTime() / 1000) - 1);
  await sweepTicketPayments(db, provider, now);
  expect(provider.payments.get("pay-1")?.status).toBe("pending");
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM ticket_orders").get()?.status).toBe("cancel_pending");
  expect(ordersForUser(db, 1)[0]?.confirmationUrl).toBeNull();
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

test("a full refund created outside the app is matched by its YooKassa payment id", async () => {
  await checkout();
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  provider.refunds.set("external-refund", {
    id: "external-refund",
    paymentId: "pay-1",
    status: "succeeded",
    amountMinor: 150000,
    currency: "RUB",
    failureReason: null,
    metadata: {},
  });

  expect(await reconcileRefund(db, provider, "external-refund", now)).toContainEqual({
    kind: "ticket_refunded",
    userId: 1,
    eventId: 1,
  });
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM ticket_orders").get()?.status).toBe("refunded");
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM registrations").get()?.status).toBe("canceled");
  expect(db.$client.query<{ provider_refund_id: string; reason: string }, []>(
    "SELECT provider_refund_id, reason FROM refunds",
  ).get()).toEqual({ provider_refund_id: "external-refund", reason: "external_refund" });
});

test("an external partial refund cannot be mistaken for a full order refund", async () => {
  await checkout();
  provider.setPaymentStatus("pay-1", "succeeded");
  await reconcilePayment(db, provider, "pay-1", now);
  provider.refunds.set("partial-refund", {
    id: "partial-refund",
    paymentId: "pay-1",
    status: "succeeded",
    amountMinor: 50000,
    currency: "RUB",
    failureReason: null,
    metadata: {},
  });

  await expect(reconcileRefund(db, provider, "partial-refund", now)).rejects.toThrow("is not a full RUB refund");
  expect(db.$client.query<{ status: string }, []>("SELECT status FROM ticket_orders").get()?.status).toBe("fulfilled");
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM refunds").get()?.count).toBe(0);
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

test("a payment that lands after abandonment is refunded without disturbing a replacement order", async () => {
  db.$client.query("UPDATE ticket_tiers SET quota = NULL WHERE id = 10").run();
  const abandoned = await checkout();
  if ("error" in abandoned) throw new Error(abandoned.error);
  await cancelPendingOrder(db, abandoned.orderId, 1, now);
  const replacement = await checkout(1, [{ productId: 21, quantity: 1 }]);
  if ("error" in replacement) throw new Error(replacement.error);
  provider.setPaymentStatus("pay-1", "succeeded");

  const result = await reconcilePayment(db, provider, "pay-1", now);
  expect(result.effects).toContainEqual({ kind: "ticket_refunded", userId: 1, eventId: 1 });
  expect(db.$client.query<{ count: number }, []>("SELECT count(*) AS count FROM registrations").get()?.count).toBe(0);
  expect(db.$client.query<{ status: string }, [string]>("SELECT status FROM ticket_orders WHERE id = ?").get(abandoned.orderId)?.status).toBe("refunded");
  expect(db.$client.query<{ status: string }, [string]>("SELECT status FROM ticket_orders WHERE id = ?").get(replacement.orderId)?.status).toBe("awaiting_payment");
});
