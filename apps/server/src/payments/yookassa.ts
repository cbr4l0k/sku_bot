import { z } from "zod";
import type { PaymentProvider, ProviderPayment, ProviderRefund } from "./provider";
import { PaymentProviderError } from "./provider";

const amountSchema = z.object({ value: z.string().regex(/^\d+\.\d{2}$/), currency: z.string() });
const paymentSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "succeeded", "canceled"]),
  amount: amountSchema,
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  confirmation: z.object({ confirmation_url: z.string().url().optional() }).optional(),
  created_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }).optional(),
});
const refundSchema = z.object({
  id: z.string().min(1),
  payment_id: z.string().min(1),
  status: z.enum(["pending", "succeeded", "canceled"]),
  amount: amountSchema,
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  cancellation_details: z.object({ reason: z.string().optional() }).optional(),
});

const minor = (value: string) => {
  const [major, fraction] = value.split(".");
  return Number(major) * 100 + Number(fraction);
};
const money = (value: number) => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
const assertReceiptTotal = (amountMinor: number, items: Parameters<PaymentProvider["createPayment"]>[0]["receiptItems"]) => {
  const total = items.reduce((sum, item) => sum + item.unitAmountMinor * item.quantity, 0);
  if (!items.length || total !== amountMinor) throw new Error("YooKassa receipt items do not match the payment amount");
};

export class YooKassaProvider implements PaymentProvider {
  readonly #authorization: string;
  readonly requiresCustomerContact: boolean;

  constructor(
    shopId: string,
    secretKey: string,
    private readonly apiBase = "https://api.yookassa.ru/v3",
    private readonly vatCode?: number,
  ) {
    this.#authorization = `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString("base64")}`;
    this.requiresCustomerContact = vatCode !== undefined;
  }

  async #request(path: string, init?: RequestInit, idempotenceKey?: string): Promise<unknown> {
    const response = await fetch(`${this.apiBase}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
      headers: {
        authorization: this.#authorization,
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(idempotenceKey ? { "idempotence-key": idempotenceKey } : {}),
        ...init?.headers,
      },
    });
    const body = await response.text();
    if (!response.ok) throw new PaymentProviderError(`YooKassa ${path} returned ${response.status}`, response.status, body);
    try {
      return JSON.parse(body);
    } catch {
      throw new PaymentProviderError(`YooKassa ${path} returned invalid JSON`, response.status, body);
    }
  }

  #payment(value: unknown): ProviderPayment {
    const payment = paymentSchema.parse(value);
    return {
      id: payment.id,
      status: payment.status,
      amountMinor: minor(payment.amount.value),
      currency: payment.amount.currency,
      metadata: Object.fromEntries(Object.entries(payment.metadata).map(([key, entry]) => [key, String(entry)])),
      confirmationUrl: payment.confirmation?.confirmation_url ?? null,
      createdAt: payment.created_at,
      expiresAt: payment.expires_at ?? null,
    };
  }

  #refund(value: unknown): ProviderRefund {
    const refund = refundSchema.parse(value);
    return {
      id: refund.id,
      paymentId: refund.payment_id,
      status: refund.status,
      amountMinor: minor(refund.amount.value),
      currency: refund.amount.currency,
      failureReason: refund.cancellation_details?.reason ?? null,
      metadata: Object.fromEntries(Object.entries(refund.metadata).map(([key, entry]) => [key, String(entry)])),
    };
  }

  async createPayment(input: Parameters<PaymentProvider["createPayment"]>[0]) {
    if (this.vatCode !== undefined && !input.customerPhone) throw new Error("A customer phone is required for a YooKassa receipt");
    assertReceiptTotal(input.amountMinor, input.receiptItems);
    const value = await this.#request("/payments", {
      method: "POST",
      body: JSON.stringify({
        amount: { value: money(input.amountMinor), currency: input.currency },
        capture: true,
        confirmation: { type: "redirect", return_url: input.returnUrl },
        description: input.description.slice(0, 128),
        metadata: { order_id: input.orderId },
        ...(this.vatCode === undefined ? {} : {
          receipt: {
            customer: { phone: input.customerPhone },
            items: input.receiptItems.map((item) => ({
              description: item.description.slice(0, 128),
              quantity: `${item.quantity}.00`,
              amount: { value: money(item.unitAmountMinor), currency: input.currency },
              vat_code: this.vatCode,
              payment_mode: "full_payment",
              payment_subject: item.paymentSubject,
            })),
          },
        }),
      }),
    }, input.idempotenceKey);
    return this.#payment(value);
  }

  async getPayment(paymentId: string) {
    return this.#payment(await this.#request(`/payments/${encodeURIComponent(paymentId)}`));
  }

  async createRefund(input: Parameters<PaymentProvider["createRefund"]>[0]) {
    if (this.vatCode !== undefined && !input.customerPhone) throw new Error("A customer phone is required for a YooKassa refund receipt");
    assertReceiptTotal(input.amountMinor, input.receiptItems);
    return this.#refund(await this.#request("/refunds", {
      method: "POST",
      body: JSON.stringify({
        payment_id: input.paymentId,
        amount: { value: money(input.amountMinor), currency: input.currency },
        description: input.reason.slice(0, 250),
        metadata: { order_id: input.orderId },
        ...(this.vatCode === undefined ? {} : {
          receipt: {
            customer: { phone: input.customerPhone },
            items: input.receiptItems.map((item) => ({
              description: item.description.slice(0, 128),
              quantity: `${item.quantity}.00`,
              amount: { value: money(item.unitAmountMinor), currency: input.currency },
              vat_code: this.vatCode,
              payment_mode: "full_payment",
              payment_subject: item.paymentSubject,
            })),
          },
        }),
      }),
    }, input.idempotenceKey));
  }

  async getRefund(refundId: string) {
    return this.#refund(await this.#request(`/refunds/${encodeURIComponent(refundId)}`));
  }
}
