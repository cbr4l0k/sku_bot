import type { Db, TicketOrderStatus } from "@sku/db";
import { PaymentProviderError, type PaymentProvider, type ProviderPayment, type ProviderRefund } from "../payments";
import type { NotificationEffect } from "./types";
import { issueOffers } from "./waitlist";

const CHECKOUT_WINDOW_SECONDS = 60 * 60;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const transaction = <T>(db: Db, work: () => T): T => db.$client.transaction(work)();

const isDefinitiveProviderRejection = (error: unknown): error is PaymentProviderError =>
  error instanceof PaymentProviderError
  && error.status >= 400
  && error.status < 500
  && error.status !== 408
  && error.status !== 429;

const providerFailureReason = (error: PaymentProviderError) => {
  try {
    const body: unknown = JSON.parse(error.responseBody);
    if (body && typeof body === "object" && "description" in body && typeof body.description === "string") {
      return body.description;
    }
  } catch {
    // Fall through to the raw provider response when it is not JSON.
  }
  return error.responseBody.trim() || error.message;
};

type TierRow = {
  id: number;
  event_id: number;
  name: string;
  price_minor: number;
  quota: number | null;
  sales_start_at: number | null;
  sales_end_at: number | null;
  active: number;
};
type ProductRow = {
  id: number;
  event_id: number;
  kind: "merchandise" | "addon";
  name: string;
  price_minor: number;
  stock: number | null;
  max_per_order: number;
  active: number;
};
type ProductVariantRow = {
  id: number;
  product_id: number;
  name: string;
  stock: number | null;
  active: number;
};
type EventRow = { id: number; title: string; status: string; ended_at: number | null; capacity: number | null };
type OrderRow = {
  id: string;
  event_id: number;
  ticket_tier_id: number | null;
  user_id: number;
  ticket_name: string | null;
  amount_minor: number;
  currency: string;
  status: TicketOrderStatus;
  expires_at: number;
};
type AttemptRow = {
  id: string;
  order_id: string;
  provider_payment_id: string | null;
  idempotence_key: string;
  status: string;
  confirmation_url: string | null;
};
type RefundRow = {
  id: string;
  order_id: string;
  payment_attempt_id: string;
  provider_refund_id: string | null;
  idempotence_key: string;
  amount_minor: number;
  status: string;
  reason: RefundReason;
};
type RefundReason = "user_canceled" | "event_canceled" | "payment_after_cancellation" | "admin_requested" | "external_refund";
type RequestedRefundReason = Exclude<RefundReason, "external_refund">;
type OrderItemRow = {
  ticket_tier_id: number | null;
  event_product_id: number | null;
  event_product_variant_id: number | null;
  kind: "ticket" | "merchandise" | "addon";
  name: string;
  variant_name: string | null;
  unit_amount_minor: number;
  quantity: number;
};

export type CheckoutError =
  | "event_not_found"
  | "event_over"
  | "not_eligible"
  | "already_joined"
  | "ticket_not_found"
  | "ticket_sales_closed"
  | "ticket_sold_out"
  | "invalid_basket"
  | "product_not_found"
  | "product_variant_required"
  | "product_variant_not_found"
  | "product_sold_out"
  | "product_limit_exceeded"
  | "active_order_exists"
  | "event_full"
  | "contact_required";

export type Checkout = {
  orderId: string;
  status: TicketOrderStatus;
  confirmationUrl: string | null;
  expiresAt: string;
};

export type PurchaseOrder = Checkout & {
  event: {
    id: number;
    title: string;
    startsAt: string;
    status: string;
  };
  amountMinor: number;
  currency: string;
  createdAt: string;
  items: Array<{
    kind: OrderItemRow["kind"];
    name: string;
    variantName: string | null;
    unitAmountMinor: number;
    quantity: number;
  }>;
};

export type EventPurchaseOrder = {
  orderId: string;
  includesTicket: boolean;
  buyer: {
    userId: number;
    firstName: string;
    lastName: string | null;
    username: string | null;
    phone: string | null;
  };
  amountMinor: number;
  currency: string;
  status: TicketOrderStatus;
  createdAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  refundFailureReason: string | null;
  refundable: boolean;
  items: PurchaseOrder["items"];
};

const orderView = (order: OrderRow, confirmationUrl: string | null): Checkout => ({
  orderId: order.id,
  status: order.status,
  confirmationUrl,
  expiresAt: new Date(order.expires_at * 1000).toISOString(),
});

const orderById = (db: Db, orderId: string) => db.$client.query<OrderRow, [string]>(
  "SELECT id, event_id, ticket_tier_id, user_id, ticket_name, amount_minor, currency, status, expires_at FROM ticket_orders WHERE id = ?",
).get(orderId);
const attemptForOrder = (db: Db, orderId: string) => db.$client.query<AttemptRow, [string]>(
  "SELECT id, order_id, provider_payment_id, idempotence_key, status, confirmation_url FROM payment_attempts WHERE order_id = ? ORDER BY created_at DESC LIMIT 1",
).get(orderId);
const itemsForOrder = (db: Db, orderId: string) => db.$client.query<OrderItemRow, [string]>(`
  SELECT ticket_tier_id, event_product_id, event_product_variant_id, kind, name, variant_name, unit_amount_minor, quantity
  FROM order_items WHERE order_id = ? ORDER BY id
`).all(orderId);
const receiptItemsForOrder = (db: Db, order: OrderRow) => {
  const items = itemsForOrder(db, order.id);
  const snapshots = items.length ? items : order.ticket_name ? [{
      ticket_tier_id: order.ticket_tier_id,
      event_product_id: null,
      event_product_variant_id: null,
      kind: "ticket" as const,
      name: order.ticket_name,
      variant_name: null,
      unit_amount_minor: order.amount_minor,
      quantity: 1,
    }] : [];
  if (!snapshots.length) throw new Error(`Order ${order.id} has no receipt items`);
  return snapshots.map((item) => ({
    description: item.variant_name ? `${item.name} — ${item.variant_name}` : item.name,
    quantity: item.quantity,
    unitAmountMinor: item.unit_amount_minor,
    paymentSubject: item.kind === "merchandise" ? "commodity" as const : "service" as const,
  }));
};

const activeOrderForUser = (db: Db, eventId: number, userId: number) => db.$client.query<OrderRow, [number, number]>(`
  SELECT id, event_id, ticket_tier_id, user_id, ticket_name, amount_minor, currency, status, expires_at
  FROM ticket_orders
  WHERE event_id = ? AND user_id = ?
    AND status = 'awaiting_payment'
  ORDER BY created_at DESC LIMIT 1
`).get(eventId, userId);

const eligible = (db: Db, eventId: number, userId: number) => db.$client.query<{ ok: number }, [number, number, number]>(`
  SELECT (NOT EXISTS (SELECT 1 FROM event_chats WHERE event_id = ?)
    OR EXISTS (
      SELECT 1 FROM event_chats
      JOIN chat_members ON chat_members.chat_id = event_chats.chat_id
      WHERE event_chats.event_id = ? AND chat_members.user_id = ? AND chat_members.is_member = 1
    )) AS ok
`).get(eventId, eventId, userId)?.ok === 1;

const confirmedCount = (db: Db, eventId: number) => db.$client.query<{ count: number }, [number]>(
  "SELECT count(*) AS count FROM registrations WHERE event_id = ? AND status IN ('registered', 'checked_in') AND is_staff = 0",
).get(eventId)?.count ?? 0;
const pendingCount = (db: Db, eventId: number) => db.$client.query<{ count: number }, [number]>(
  "SELECT count(*) AS count FROM ticket_orders WHERE event_id = ? AND ticket_tier_id IS NOT NULL AND status IN ('awaiting_payment', 'payment_succeeded')",
).get(eventId)?.count ?? 0;
const tierClaimCount = (db: Db, tierId: number) => db.$client.query<{ count: number }, [number]>(`
  SELECT count(*) AS count FROM ticket_orders
  WHERE ticket_tier_id = ? AND status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
`).get(tierId)?.count ?? 0;
const productClaimCount = (db: Db, productId: number) => db.$client.query<{ count: number | null }, [number]>(`
  SELECT sum(i.quantity) AS count FROM order_items i
  JOIN ticket_orders o ON o.id = i.order_id
  WHERE i.event_product_id = ?
    AND o.status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
`).get(productId)?.count ?? 0;
const productVariantClaimCount = (db: Db, variantId: number) => db.$client.query<{ count: number | null }, [number]>(`
  SELECT sum(i.quantity) AS count FROM order_items i
  JOIN ticket_orders o ON o.id = i.order_id
  WHERE i.event_product_variant_id = ?
    AND o.status IN ('awaiting_payment', 'payment_succeeded', 'fulfilled', 'refund_pending', 'refund_failed')
`).get(variantId)?.count ?? 0;

type RequestedProduct = { productId: number; variantId: number | null; quantity: number };
const requestKey = (productId: number, variantId: number | null) => `${productId}:${variantId ?? "base"}`;
const requestedProducts = (items: ReadonlyArray<{ productId: number; variantId?: number | null; quantity: number }>) => {
  const quantities = new Map<string, RequestedProduct>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.productId) || item.productId < 1
      || (item.variantId !== undefined && item.variantId !== null && (!Number.isSafeInteger(item.variantId) || item.variantId < 1))
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1) return null;
    const variantId = item.variantId ?? null;
    const key = requestKey(item.productId, variantId);
    quantities.set(key, { productId: item.productId, variantId, quantity: (quantities.get(key)?.quantity ?? 0) + item.quantity });
  }
  return quantities.size <= 20 ? quantities : null;
};

const basketMatches = (db: Db, order: OrderRow, tierId: number | null, products: ReadonlyMap<string, RequestedProduct>) => {
  if (order.ticket_tier_id !== tierId) return false;
  const existing = new Map(itemsForOrder(db, order.id)
    .filter((item) => item.event_product_id !== null)
    .map((item) => [requestKey(item.event_product_id!, item.event_product_variant_id), item.quantity]));
  return existing.size === products.size && [...products].every(([key, item]) => existing.get(key) === item.quantity);
};

const verifyPayment = (order: OrderRow, payment: ProviderPayment) => {
  if (payment.metadata.order_id !== order.id) throw new Error(`Payment ${payment.id} has the wrong order metadata`);
  if (payment.amountMinor !== order.amount_minor || payment.currency !== order.currency) {
    throw new Error(`Payment ${payment.id} amount does not match order ${order.id}`);
  }
};

/** Reserve inventory first, then create the remote payment with a stable idempotency key. */
export const createCheckout = async (
  db: Db,
  provider: PaymentProvider,
  input: {
    eventId: number;
    tierId?: number | null;
    productItems?: ReadonlyArray<{ productId: number; variantId?: number | null; quantity: number }>;
    userId: number;
    returnUrl: string;
    userPhone?: string | null;
  },
  now: Date,
): Promise<Checkout | { error: CheckoutError }> => {
  const phoneDigits = input.userPhone?.replace(/\D/g, "") ?? "";
  const receiptPhone = phoneDigits.length >= 8 && phoneDigits.length <= 15 ? `+${phoneDigits}` : null;
  if (provider.requiresCustomerContact && !receiptPhone) return { error: "contact_required" };
  const products = requestedProducts(input.productItems ?? []);
  if (!products) return { error: "invalid_basket" };
  const tierId = input.tierId ?? null;
  if (tierId === null && products.size === 0) return { error: "invalid_basket" };
  const prepared = transaction(db, () => {
    const event = db.$client.query<EventRow, [number]>(
      "SELECT id, title, status, ended_at, capacity FROM events WHERE id = ?",
    ).get(input.eventId);
    if (!event || event.status !== "published") return { error: "event_not_found" as const };
    if (event.ended_at !== null) return { error: "event_over" as const };
    if (!eligible(db, event.id, input.userId)) return { error: "not_eligible" as const };

    if (tierId !== null) {
      const registration = db.$client.query<{ status: string }, [number, number]>(
        "SELECT status FROM registrations WHERE event_id = ? AND user_id = ?",
      ).get(event.id, input.userId);
      if (registration && ["registered", "checked_in"].includes(registration.status)) return { error: "already_joined" as const };
    }

    const existing = activeOrderForUser(db, event.id, input.userId);
    if (existing) {
      if (!basketMatches(db, existing, tierId, products)) return { error: "active_order_exists" as const };
      return { order: existing, attempt: attemptForOrder(db, existing.id), event, existing: true as const };
    }

    const timestamp = seconds(now);
    let tier: TierRow | null = null;
    if (tierId !== null) {
      tier = db.$client.query<TierRow, [number, number]>(`
        SELECT id, event_id, name, price_minor, quota, sales_start_at, sales_end_at, active
        FROM ticket_tiers WHERE id = ? AND event_id = ?
      `).get(tierId, event.id) ?? null;
      if (!tier || !tier.active) return { error: "ticket_not_found" as const };
      if ((tier.sales_start_at !== null && tier.sales_start_at > timestamp)
        || (tier.sales_end_at !== null && tier.sales_end_at <= timestamp)) return { error: "ticket_sales_closed" as const };
      if (tier.quota !== null && tierClaimCount(db, tier.id) >= tier.quota) return { error: "ticket_sold_out" as const };
      if (event.capacity !== null && confirmedCount(db, event.id) + pendingCount(db, event.id) >= event.capacity) {
        return { error: "event_full" as const };
      }
    }

    const selectedProducts: Array<ProductRow & { quantity: number; variantId: number | null; variantName: string | null }> = [];
    const totalsByProduct = new Map<number, number>();
    for (const { productId, variantId, quantity } of products.values()) {
      const product = db.$client.query<ProductRow, [number, number]>(`
        SELECT id, event_id, kind, name, price_minor, stock, max_per_order, active
        FROM event_products WHERE id = ? AND event_id = ?
      `).get(productId, event.id);
      if (!product || !product.active) return { error: "product_not_found" as const };
      const productTotal = (totalsByProduct.get(product.id) ?? 0) + quantity;
      totalsByProduct.set(product.id, productTotal);
      if (productTotal > product.max_per_order) return { error: "product_limit_exceeded" as const };
      const hasVariants = (db.$client.query<{ count: number }, [number]>(
        "SELECT count(*) AS count FROM event_product_variants WHERE product_id = ? AND active = 1",
      ).get(product.id)?.count ?? 0) > 0;
      if (hasVariants && variantId === null) return { error: "product_variant_required" as const };
      if (!hasVariants && variantId !== null) return { error: "product_variant_not_found" as const };
      const variant = variantId === null ? null : db.$client.query<ProductVariantRow, [number, number]>(`
        SELECT id, product_id, name, stock, active
        FROM event_product_variants WHERE id = ? AND product_id = ?
      `).get(variantId, product.id) ?? null;
      if (variantId !== null && (!variant || !variant.active)) return { error: "product_variant_not_found" as const };
      const stock = variant ? variant.stock : product.stock;
      const claimed = variant ? productVariantClaimCount(db, variant.id) : productClaimCount(db, product.id);
      if (stock !== null && claimed + quantity > stock) {
        return { error: "product_sold_out" as const };
      }
      selectedProducts.push({ ...product, quantity, variantId: variant?.id ?? null, variantName: variant?.name ?? null });
    }

    const amountMinor = (tier?.price_minor ?? 0) + selectedProducts.reduce((sum, product) => sum + product.price_minor * product.quantity, 0);
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) return { error: "invalid_basket" as const };

    const orderId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const idempotenceKey = crypto.randomUUID();
    const expiresAt = timestamp + CHECKOUT_WINDOW_SECONDS;
    db.$client.query(`
      INSERT INTO ticket_orders
        (id, event_id, ticket_tier_id, user_id, ticket_name, amount_minor, currency, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'RUB', 'awaiting_payment', ?, ?, ?)
    `).run(orderId, event.id, tier?.id ?? null, input.userId, tier?.name ?? null, amountMinor, expiresAt, timestamp, timestamp);
    if (tier) {
      db.$client.query(`
        INSERT INTO order_items
          (order_id, ticket_tier_id, event_product_id, event_product_variant_id, kind, name, variant_name, unit_amount_minor, quantity, created_at)
        VALUES (?, ?, NULL, NULL, 'ticket', ?, NULL, ?, 1, ?)
      `).run(orderId, tier.id, tier.name, tier.price_minor, timestamp);
    }
    for (const product of selectedProducts) {
      db.$client.query(`
        INSERT INTO order_items
          (order_id, ticket_tier_id, event_product_id, event_product_variant_id, kind, name, variant_name, unit_amount_minor, quantity, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(orderId, product.id, product.variantId, product.kind, product.name, product.variantName, product.price_minor, product.quantity, timestamp);
    }
    db.$client.query(`
      INSERT INTO payment_attempts (id, order_id, provider, idempotence_key, status, created_at, updated_at)
      VALUES (?, ?, 'yookassa', ?, 'pending', ?, ?)
    `).run(attemptId, orderId, idempotenceKey, timestamp, timestamp);
    return { order: orderById(db, orderId)!, attempt: attemptForOrder(db, orderId)!, event, existing: false as const };
  });

  if ("error" in prepared && prepared.error !== undefined) return { error: prepared.error };
  if (prepared.attempt?.confirmation_url) return orderView(prepared.order, prepared.attempt.confirmation_url);
  if (!prepared.attempt) throw new Error(`Order ${prepared.order.id} has no payment attempt`);

  try {
    const payment = await provider.createPayment({
      amountMinor: prepared.order.amount_minor,
      currency: "RUB",
      description: `${prepared.event.title} — ${prepared.order.ticket_name ?? receiptItemsForOrder(db, prepared.order)[0]!.description}`,
      orderId: prepared.order.id,
      returnUrl: input.returnUrl,
      idempotenceKey: prepared.attempt.idempotence_key,
      receiptItems: receiptItemsForOrder(db, prepared.order),
      ...(receiptPhone ? { customerPhone: receiptPhone } : {}),
    });
    verifyPayment(prepared.order, payment);
    const expiresAt = payment.expiresAt ? Math.floor(new Date(payment.expiresAt).getTime() / 1000) : prepared.order.expires_at;
    const timestamp = seconds(now);
    db.$client.query(`
      UPDATE payment_attempts SET provider_payment_id = ?, status = ?, confirmation_url = ?, provider_created_at = ?, updated_at = ? WHERE id = ?
    `).run(payment.id, payment.status, payment.confirmationUrl, payment.createdAt, timestamp, prepared.attempt.id);
    db.$client.query("UPDATE ticket_orders SET expires_at = ?, updated_at = ? WHERE id = ?")
      .run(expiresAt, timestamp, prepared.order.id);
    if (payment.status !== "pending") await reconcilePayment(db, provider, payment.id, now);
    const current = orderById(db, prepared.order.id)!;
    return orderView(current, payment.confirmationUrl);
  } catch (error) {
    // A timeout can hide a remotely created payment. Keep the attempt identity for
    // webhook recovery, but release only after marking this order cancel-pending.
    const definitiveRejection = error instanceof PaymentProviderError && error.status >= 400 && error.status < 500;
    db.$client.query("UPDATE ticket_orders SET status = ?, canceled_at = ?, updated_at = ? WHERE id = ?")
      .run(definitiveRejection ? "canceled" : "cancel_pending", definitiveRejection ? seconds(now) : null, seconds(now), prepared.order.id);
    throw error;
  }
};

const applyRefund = (db: Db, refundRow: RefundRow, remote: ProviderRefund, now: Date): NotificationEffect[] => {
  if (remote.id !== refundRow.provider_refund_id && refundRow.provider_refund_id !== null) throw new Error("Refund id mismatch");
  if (remote.amountMinor !== refundRow.amount_minor || remote.currency !== "RUB") throw new Error("Refund amount mismatch");
  const order = orderById(db, refundRow.order_id);
  if (!order) throw new Error(`Refund ${refundRow.id} points to a missing order`);
  const hasTicket = order.ticket_tier_id !== null;
  const timestamp = seconds(now);
  const shouldOffer = hasTicket && remote.status === "succeeded" && db.$client.query<{ status: string }, [number]>(
    "SELECT status FROM events WHERE id = ?",
  ).get(order.event_id)?.status === "published";

  transaction(db, () => {
    db.$client.query("UPDATE refunds SET provider_refund_id = ?, status = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
      .run(remote.id, remote.status, remote.failureReason, timestamp, refundRow.id);
    if (remote.status === "succeeded") {
      db.$client.query("UPDATE ticket_orders SET status = 'refunded', refunded_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, order.id);
      if (hasTicket) {
        db.$client.query("UPDATE registrations SET status = 'canceled', checked_in_at = NULL, updated_at = ? WHERE event_id = ? AND user_id = ? AND status IN ('registered', 'checked_in')")
          .run(timestamp, order.event_id, order.user_id);
      }
    } else if (remote.status === "canceled") {
      db.$client.query("UPDATE ticket_orders SET status = 'refund_failed', updated_at = ? WHERE id = ?")
        .run(timestamp, order.id);
    }
  });
  const effects: NotificationEffect[] = shouldOffer ? issueOffers(db, order.event_id, now) : [];
  if (remote.status === "succeeded" && refundRow.status !== "succeeded") {
    effects.push({ kind: hasTicket ? "ticket_refunded" : "purchase_refunded", userId: order.user_id, eventId: order.event_id });
  } else if (remote.status === "canceled" && refundRow.status !== "canceled") {
    effects.push({ kind: hasTicket ? "ticket_refund_failed" : "purchase_refund_failed", userId: order.user_id, eventId: order.event_id });
  }
  return effects;
};

export const ensureRefund = async (
  db: Db,
  provider: PaymentProvider,
  orderId: string,
  reason: RequestedRefundReason,
  now: Date,
): Promise<NotificationEffect[]> => {
  const knownOrder = orderById(db, orderId);
  if (!knownOrder) throw new Error(`Order ${orderId} was not found`);
  if (knownOrder.status === "refunded") return [];
  const knownRefund = db.$client.query<RefundRow, [string]>(`
    SELECT id, order_id, payment_attempt_id, provider_refund_id, idempotence_key, amount_minor, status, reason
    FROM refunds WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(orderId);
  // A known provider refund can be fetched directly. Otherwise, first look for
  // one created in the YooKassa dashboard or recovered after an ambiguous API
  // failure, using the immutable provider payment id as the link.
  if (knownRefund?.provider_refund_id && knownRefund.status !== "canceled") {
    return applyRefund(db, knownRefund, await provider.getRefund(knownRefund.provider_refund_id), now);
  }
  const knownAttempt = db.$client.query<AttemptRow, [string]>(`
    SELECT id, order_id, provider_payment_id, idempotence_key, status, confirmation_url
    FROM payment_attempts
    WHERE order_id = ? AND status = 'succeeded' AND provider_payment_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(orderId);
  if (!knownAttempt?.provider_payment_id) throw new Error(`Order ${orderId} has no succeeded payment`);
  const activeRefunds = (await provider.getRefundsForPayment(knownAttempt.provider_payment_id))
    .filter((refund) => refund.status !== "canceled");
  const existingFullRefunds = activeRefunds.filter((refund) =>
    refund.amountMinor === knownOrder.amount_minor && refund.currency === knownOrder.currency
  );
  if (existingFullRefunds.length > 1) {
    throw new Error(`Payment ${knownAttempt.provider_payment_id} has multiple active full refunds; nothing was changed`);
  }
  if (existingFullRefunds[0]) return reconcileRefund(db, provider, existingFullRefunds[0].id, now);
  if (activeRefunds.length > 0) {
    throw new Error(`Payment ${knownAttempt.provider_payment_id} already has a partial refund; nothing was changed`);
  }

  const prepared = transaction(db, () => {
    const order = orderById(db, orderId);
    if (!order) throw new Error(`Order ${orderId} was not found`);
    if (order.status === "refunded") return { done: true as const };
    const attempt = db.$client.query<AttemptRow, [string]>(`
      SELECT id, order_id, provider_payment_id, idempotence_key, status, confirmation_url
      FROM payment_attempts WHERE order_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1
    `).get(orderId);
    if (!attempt?.provider_payment_id) throw new Error(`Order ${orderId} has no succeeded payment`);
    const existing = db.$client.query<RefundRow, [string]>(`
      SELECT id, order_id, payment_attempt_id, provider_refund_id, idempotence_key, amount_minor, status, reason
      FROM refunds WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(orderId);
    // A canceled provider refund is terminal. A later explicit retry needs a new
    // local row and idempotence key; reusing the old one can only return the same
    // canceled provider object forever.
    if (existing && existing.status !== "canceled") return { order, attempt, refund: existing, done: false as const };
    const timestamp = seconds(now);
    const refund: RefundRow = {
      id: crypto.randomUUID(), order_id: orderId, payment_attempt_id: attempt.id,
      provider_refund_id: null, idempotence_key: crypto.randomUUID(), amount_minor: order.amount_minor, status: "pending", reason,
    };
    db.$client.query(`
      INSERT INTO refunds (id, order_id, payment_attempt_id, idempotence_key, amount_minor, status, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(refund.id, orderId, attempt.id, refund.idempotence_key, refund.amount_minor, reason, timestamp, timestamp);
    db.$client.query("UPDATE ticket_orders SET status = 'refund_pending', updated_at = ? WHERE id = ?")
      .run(timestamp, orderId);
    return { order, attempt, refund, done: false as const };
  });
  if (prepared.done) return [];
  if (prepared.refund.provider_refund_id) return applyRefund(
    db, prepared.refund, await provider.getRefund(prepared.refund.provider_refund_id), now,
  );
  try {
    const remote = await provider.createRefund({
      paymentId: prepared.attempt.provider_payment_id!,
      amountMinor: prepared.order.amount_minor,
      currency: "RUB",
      orderId,
      reason,
      description: prepared.order.ticket_name ?? receiptItemsForOrder(db, prepared.order)[0]!.description,
      receiptItems: receiptItemsForOrder(db, prepared.order),
      ...(() => {
        const phone = db.$client.query<{ phone: string | null }, [string]>(`
          SELECT u.phone FROM users u JOIN ticket_orders o ON o.user_id = u.id WHERE o.id = ?
        `).get(orderId)?.phone;
        const digits = phone?.replace(/\D/g, "") ?? "";
        return digits.length >= 8 && digits.length <= 15 ? { customerPhone: `+${digits}` } : {};
      })(),
      idempotenceKey: prepared.refund.idempotence_key,
    });
    return applyRefund(db, prepared.refund, remote, now);
  } catch (error) {
    // Authentication, permission, validation, and missing-resource errors cannot
    // succeed by repeating the same request every 30 seconds. Record the failure
    // and require an explicit retry after its cause has been corrected. Timeouts
    // and rate limiting remain pending because they are expected to recover.
    if (!isDefinitiveProviderRejection(error)) throw error;
    const timestamp = seconds(now);
    transaction(db, () => {
      db.$client.query("UPDATE refunds SET status = 'canceled', failure_reason = ?, updated_at = ? WHERE id = ?")
        .run(providerFailureReason(error), timestamp, prepared.refund.id);
      db.$client.query("UPDATE ticket_orders SET status = 'refund_failed', updated_at = ? WHERE id = ?")
        .run(timestamp, prepared.order.id);
    });
    return [{
      kind: prepared.order.ticket_tier_id === null ? "purchase_refund_failed" : "ticket_refund_failed",
      userId: prepared.order.user_id,
      eventId: prepared.order.event_id,
    }];
  }
};

/** Fetching the payment here is the authenticity check; webhook JSON is never trusted. */
export const reconcilePayment = async (
  db: Db,
  provider: PaymentProvider,
  paymentId: string,
  now: Date,
): Promise<{ orderId: string | null; effects: NotificationEffect[] }> => {
  const payment = await provider.getPayment(paymentId);
  let attempt = db.$client.query<AttemptRow, [string]>(`
    SELECT id, order_id, provider_payment_id, idempotence_key, status, confirmation_url
    FROM payment_attempts WHERE provider_payment_id = ?
  `).get(payment.id);
  if (!attempt && payment.metadata.order_id) {
    attempt = attemptForOrder(db, payment.metadata.order_id);
    if (attempt && attempt.provider_payment_id === null) {
      db.$client.query("UPDATE payment_attempts SET provider_payment_id = ? WHERE id = ?").run(payment.id, attempt.id);
      attempt = { ...attempt, provider_payment_id: payment.id };
    }
  }
  if (!attempt) return { orderId: null, effects: [] };
  const order = orderById(db, attempt.order_id);
  if (!order) throw new Error(`Payment ${payment.id} points to a missing order`);
  verifyPayment(order, payment);
  const timestamp = seconds(now);

  if (payment.status === "pending") return { orderId: order.id, effects: [] };
  if (payment.status === "canceled") {
    transaction(db, () => {
      db.$client.query("UPDATE payment_attempts SET status = 'canceled', updated_at = ? WHERE id = ?").run(timestamp, attempt!.id);
      if (["awaiting_payment", "cancel_pending"].includes(order.status)) {
        db.$client.query("UPDATE ticket_orders SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE id = ?")
          .run(timestamp, timestamp, order.id);
      }
    });
    return { orderId: order.id, effects: [] };
  }

  const result = transaction(db, () => {
    db.$client.query("UPDATE payment_attempts SET status = 'succeeded', updated_at = ? WHERE id = ?").run(timestamp, attempt!.id);
    const event = db.$client.query<{ status: string; ended_at: number | null }, [number]>(
      "SELECT status, ended_at FROM events WHERE id = ?",
    ).get(order.event_id);
    if (!event || event.status === "canceled" || event.ended_at !== null || order.status === "cancel_pending" || order.status === "canceled") {
      db.$client.query("UPDATE ticket_orders SET status = 'payment_succeeded', paid_at = coalesce(paid_at, ?), updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, order.id);
      return { needsRefund: true, fulfilled: false };
    }
    if (order.status !== "fulfilled" && order.status !== "refund_pending" && order.status !== "refund_failed" && order.status !== "refunded") {
      if (order.ticket_tier_id !== null) {
        const registration = db.$client.query<{ id: number }, [number, number]>(
          "SELECT id FROM registrations WHERE event_id = ? AND user_id = ?",
        ).get(order.event_id, order.user_id);
        if (registration) {
          db.$client.query("UPDATE registrations SET status = 'registered', checked_in_at = NULL, updated_at = ? WHERE id = ?")
            .run(timestamp, registration.id);
        } else {
          db.$client.query("INSERT INTO registrations (event_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'registered', ?, ?)")
            .run(order.event_id, order.user_id, timestamp, timestamp);
        }
      }
      db.$client.query("UPDATE ticket_orders SET status = 'fulfilled', paid_at = coalesce(paid_at, ?), fulfilled_at = coalesce(fulfilled_at, ?), updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, timestamp, order.id);
      return { needsRefund: false, fulfilled: true };
    }
    return { needsRefund: false, fulfilled: false };
  });
  const effects: NotificationEffect[] = result.needsRefund
    ? await ensureRefund(db, provider, order.id, "payment_after_cancellation", now)
    : result.fulfilled ? [{
        kind: order.ticket_tier_id === null ? "purchase_paid" : "ticket_paid",
        userId: order.user_id,
        eventId: order.event_id,
      }] : [];
  return { orderId: order.id, effects };
};

export const requestUserRefund = async (db: Db, provider: PaymentProvider, eventId: number, userId: number, now: Date) => {
  const order = db.$client.query<{ id: string }, [number, number]>(`
    SELECT id FROM ticket_orders
    WHERE event_id = ? AND user_id = ? AND ticket_tier_id IS NOT NULL
      AND status IN ('fulfilled', 'refund_pending', 'refund_failed')
    ORDER BY created_at DESC LIMIT 1
  `).get(eventId, userId);
  if (!order) return null;
  return ensureRefund(db, provider, order.id, "user_canceled", now);
};

export const requestAdminRefund = async (
  db: Db,
  provider: PaymentProvider,
  eventId: number,
  orderId: string,
  now: Date,
): Promise<{ effects: NotificationEffect[] } | { error: "order_not_found" | "order_not_refundable" }> => {
  const order = orderById(db, orderId);
  if (!order || order.event_id !== eventId) return { error: "order_not_found" };
  if (!["fulfilled", "payment_succeeded", "refund_failed"].includes(order.status)) {
    return { error: "order_not_refundable" };
  }

  return { effects: await ensureRefund(db, provider, order.id, "admin_requested", now) };
};

export const reconcileRefund = async (db: Db, provider: PaymentProvider, refundId: string, now: Date) => {
  const remote = await provider.getRefund(refundId);
  let refund = db.$client.query<RefundRow, [string]>(`
    SELECT id, order_id, payment_attempt_id, provider_refund_id, idempotence_key, amount_minor, status, reason
    FROM refunds WHERE provider_refund_id = ?
  `).get(remote.id);
  if (!refund && remote.metadata.order_id) {
    refund = db.$client.query<RefundRow, [string]>(`
      SELECT id, order_id, payment_attempt_id, provider_refund_id, idempotence_key, amount_minor, status, reason
      FROM refunds WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(remote.metadata.order_id);
    if (refund && refund.provider_refund_id === null) {
      db.$client.query("UPDATE refunds SET provider_refund_id = ? WHERE id = ?").run(remote.id, refund.id);
      refund = { ...refund, provider_refund_id: remote.id };
    }
  }
  if (!refund) {
    // Refunds created in the YooKassa dashboard do not carry the order metadata
    // that we attach to API-created refunds. The refund object still contains the
    // original payment id, which is a unique and authoritative local link.
    refund = transaction(db, () => {
      const attempt = db.$client.query<AttemptRow, [string]>(`
        SELECT id, order_id, provider_payment_id, idempotence_key, status, confirmation_url
        FROM payment_attempts
        WHERE provider_payment_id = ? AND status = 'succeeded'
      `).get(remote.paymentId);
      if (!attempt) return null;
      if (remote.metadata.order_id && remote.metadata.order_id !== attempt.order_id) {
        throw new Error(`Refund ${remote.id} order metadata does not match payment ${remote.paymentId}`);
      }

      const existing = db.$client.query<RefundRow, [string]>(`
        SELECT id, order_id, payment_attempt_id, provider_refund_id, idempotence_key, amount_minor, status, reason
        FROM refunds WHERE order_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(attempt.order_id);
      if (existing) {
        if (existing.provider_refund_id !== null && existing.provider_refund_id !== remote.id) {
          throw new Error(`Order ${attempt.order_id} already has a different refund`);
        }
        db.$client.query("UPDATE refunds SET provider_refund_id = ? WHERE id = ?").run(remote.id, existing.id);
        return { ...existing, provider_refund_id: remote.id };
      }

      const order = orderById(db, attempt.order_id);
      if (!order) return null;
      if (remote.amountMinor !== order.amount_minor || remote.currency !== order.currency) {
        throw new Error(`External refund ${remote.id} is not a full ${order.currency} refund for order ${order.id}`);
      }

      const timestamp = seconds(now);
      const created: RefundRow = {
        id: crypto.randomUUID(),
        order_id: order.id,
        payment_attempt_id: attempt.id,
        provider_refund_id: remote.id,
        idempotence_key: crypto.randomUUID(),
        amount_minor: order.amount_minor,
        status: "pending",
        reason: "external_refund",
      };
      db.$client.query(`
        INSERT INTO refunds
          (id, order_id, payment_attempt_id, provider_refund_id, idempotence_key, amount_minor, status, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 'external_refund', ?, ?)
      `).run(
        created.id, created.order_id, created.payment_attempt_id, created.provider_refund_id,
        created.idempotence_key, created.amount_minor, timestamp, timestamp,
      );
      if (remote.status === "pending") {
        db.$client.query("UPDATE ticket_orders SET status = 'refund_pending', updated_at = ? WHERE id = ?")
          .run(timestamp, order.id);
      }
      return created;
    });
  }
  return refund ? applyRefund(db, refund, remote, now) : [];
};

export const refundCanceledEvent = async (db: Db, provider: PaymentProvider, eventId: number, now: Date) => {
  const orders = db.$client.query<{ id: string }, [number]>(`
    SELECT id FROM ticket_orders WHERE event_id = ? AND status IN ('fulfilled', 'payment_succeeded', 'refund_pending')
  `).all(eventId);
  const effects: NotificationEffect[] = [];
  for (const order of orders) effects.push(...await ensureRefund(db, provider, order.id, "event_canceled", now));
  return effects;
};

export const sweepTicketPayments = async (db: Db, provider: PaymentProvider, now: Date) => {
  const timestamp = seconds(now);
  const effects: NotificationEffect[] = [];
  // Webhooks are the fast path, not a single point of failure. Polling the same
  // authoritative provider object heals a lost notification without trusting the client.
  const awaitingRemote = db.$client.query<{ provider_payment_id: string }, []>(`
    SELECT p.provider_payment_id FROM ticket_orders o
    JOIN payment_attempts p ON p.order_id = o.id
    WHERE o.status IN ('awaiting_payment', 'cancel_pending') AND p.provider_payment_id IS NOT NULL
  `).all();
  for (const row of awaitingRemote) {
    effects.push(...(await reconcilePayment(db, provider, row.provider_payment_id, now)).effects);
  }

  const expiring = db.$client.query<{ id: string; provider_payment_id: string | null }, [number]>(`
    SELECT o.id, p.provider_payment_id
    FROM ticket_orders o JOIN payment_attempts p ON p.order_id = o.id
    WHERE o.status IN ('awaiting_payment', 'cancel_pending') AND o.expires_at <= ?
  `).all(timestamp);
  for (const row of expiring) {
    if (!row.provider_payment_id) {
      db.$client.query("UPDATE ticket_orders SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, row.id);
      continue;
    }
    // Payments with provider ids were reconciled in the pass above.
    const current = orderById(db, row.id);
    if (current && ["awaiting_payment", "cancel_pending"].includes(current.status)) {
      // One-stage YooKassa payments cannot be canceled through /payments/:id/cancel
      // while they are pending. Abandon the checkout locally, release its inventory,
      // and keep polling it above until YooKassa reports a terminal status. A late
      // success is automatically refunded by reconcilePayment.
      db.$client.query("UPDATE ticket_orders SET status = 'cancel_pending', updated_at = ? WHERE id = ?")
        .run(timestamp, row.id);
      db.$client.query("UPDATE payment_attempts SET confirmation_url = NULL, updated_at = ? WHERE order_id = ?")
        .run(timestamp, row.id);
    }
  }

  const pendingRefunds = db.$client.query<RefundRow, []>(`
    SELECT id, order_id, payment_attempt_id, provider_refund_id, idempotence_key, amount_minor, status, reason
    FROM refunds WHERE status = 'pending'
  `).all();
  for (const refund of pendingRefunds) {
    if (refund.provider_refund_id) {
      effects.push(...applyRefund(db, refund, await provider.getRefund(refund.provider_refund_id), now));
    } else {
      if (refund.reason === "external_refund") throw new Error(`External refund ${refund.id} has no provider id`);
      effects.push(...await ensureRefund(db, provider, refund.order_id, refund.reason, now));
    }
  }

  // A restart or temporary provider outage must not strand refunds triggered by
  // event cancellation. The next sweep resumes every unfinished canceled event.
  const canceledPaidEvents = db.$client.query<{ event_id: number }, []>(`
    SELECT DISTINCT o.event_id FROM ticket_orders o
    JOIN events e ON e.id = o.event_id
    WHERE e.status = 'canceled' AND o.status IN ('fulfilled', 'payment_succeeded', 'refund_pending')
  `).all();
  for (const row of canceledPaidEvents) effects.push(...await refundCanceledEvent(db, provider, row.event_id, now));
  return effects;
};

export const orderForUser = (db: Db, orderId: string, userId: number) => {
  const order = orderById(db, orderId);
  if (!order || order.user_id !== userId) return null;
  return orderView(order, attemptForOrder(db, order.id)?.confirmation_url ?? null);
};

export const ordersForUser = (db: Db, userId: number): PurchaseOrder[] => {
  const orders = db.$client.query<OrderRow & {
    event_title: string;
    event_starts_at: number;
    event_status: string;
    created_at: number;
  }, [number]>(`
    SELECT o.id, o.event_id, o.ticket_tier_id, o.user_id, o.ticket_name,
      o.amount_minor, o.currency, o.status, o.expires_at, o.created_at,
      e.title AS event_title, e.starts_at AS event_starts_at, e.status AS event_status
    FROM ticket_orders o
    JOIN events e ON e.id = o.event_id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC, o.id DESC
  `).all(userId);

  return orders.map((order) => ({
    ...orderView(order, attemptForOrder(db, order.id)?.confirmation_url ?? null),
    event: {
      id: order.event_id,
      title: order.event_title,
      startsAt: new Date(order.event_starts_at * 1000).toISOString(),
      status: order.event_status,
    },
    amountMinor: order.amount_minor,
    currency: order.currency,
    createdAt: new Date(order.created_at * 1000).toISOString(),
    items: itemsForOrder(db, order.id).map((item) => ({
      kind: item.kind,
      name: item.name,
      variantName: item.variant_name,
      unitAmountMinor: item.unit_amount_minor,
      quantity: item.quantity,
    })),
  }));
};

export const ordersForEvent = (db: Db, eventId: number): EventPurchaseOrder[] => {
  const orders = db.$client.query<OrderRow & {
    first_name: string;
    last_name: string | null;
    username: string | null;
    phone: string | null;
    created_at: number;
    paid_at: number | null;
    refunded_at: number | null;
    refund_failure_reason: string | null;
  }, [number]>(`
    SELECT o.id, o.event_id, o.ticket_tier_id, o.user_id, o.ticket_name,
      o.amount_minor, o.currency, o.status, o.expires_at, o.created_at,
      o.paid_at, o.refunded_at,
      u.first_name, u.last_name, u.username, u.phone,
      (SELECT r.failure_reason FROM refunds r WHERE r.order_id = o.id ORDER BY r.created_at DESC LIMIT 1)
        AS refund_failure_reason
    FROM ticket_orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.event_id = ?
    ORDER BY o.created_at DESC, o.id DESC
  `).all(eventId);

  return orders.map((order) => ({
    orderId: order.id,
    includesTicket: order.ticket_tier_id !== null,
    buyer: {
      userId: order.user_id,
      firstName: order.first_name,
      lastName: order.last_name,
      username: order.username,
      phone: order.phone,
    },
    amountMinor: order.amount_minor,
    currency: order.currency,
    status: order.status,
    createdAt: new Date(order.created_at * 1000).toISOString(),
    paidAt: order.paid_at === null ? null : new Date(order.paid_at * 1000).toISOString(),
    refundedAt: order.refunded_at === null ? null : new Date(order.refunded_at * 1000).toISOString(),
    refundFailureReason: order.refund_failure_reason,
    refundable: ["fulfilled", "payment_succeeded", "refund_failed"].includes(order.status),
    items: itemsForOrder(db, order.id).map((item) => ({
      kind: item.kind,
      name: item.name,
      variantName: item.variant_name,
      unitAmountMinor: item.unit_amount_minor,
      quantity: item.quantity,
    })),
  }));
};

/**
 * Abandon an unfinished checkout locally. Pending one-stage YooKassa payments
 * cannot be canceled via the API, so the sweeper keeps reconciling the remote
 * payment and refunds it if it somehow succeeds after abandonment.
 */
export const cancelPendingOrder = async (
  db: Db,
  orderId: string,
  userId: number,
  now: Date,
): Promise<Checkout | { error: "order_not_found" | "order_not_cancelable" }> => {
  const initial = orderById(db, orderId);
  if (!initial || initial.user_id !== userId) return { error: "order_not_found" };
  if (!["awaiting_payment", "cancel_pending"].includes(initial.status)) return { error: "order_not_cancelable" };

  const attempt = attemptForOrder(db, orderId);
  const timestamp = seconds(now);
  if (!attempt?.provider_payment_id) {
    db.$client.query("UPDATE ticket_orders SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, orderId);
    return orderView(orderById(db, orderId)!, null);
  }

  transaction(db, () => {
    db.$client.query("UPDATE ticket_orders SET status = 'cancel_pending', updated_at = ? WHERE id = ?")
      .run(timestamp, orderId);
    db.$client.query("UPDATE payment_attempts SET confirmation_url = NULL, updated_at = ? WHERE id = ?")
      .run(timestamp, attempt.id);
  });
  return orderView(orderById(db, orderId)!, null);
};
