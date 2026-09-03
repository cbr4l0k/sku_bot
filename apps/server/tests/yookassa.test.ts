import { expect, spyOn, test } from "bun:test";

import { YooKassaProvider } from "../src/payments/yookassa";

test("YooKassa requests keep credentials server-side and carry idempotency, metadata, and receipt data", async () => {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url: String(input), headers: new Headers(init?.headers), body });
    if (String(input).includes("/refunds?")) {
      return Response.json({
        type: "list",
        items: [{
          id: "refund-1",
          payment_id: "payment-1",
          status: "succeeded",
          amount: { value: "1500.00", currency: "RUB" },
          metadata: {},
        }],
      });
    }
    if (String(input).endsWith("/payments")) {
      return Response.json({
        id: "payment-1",
        status: "pending",
        amount: { value: "6500.00", currency: "RUB" },
        metadata: { order_id: "order-1" },
        confirmation: { confirmation_url: "https://yoomoney.ru/checkout/1" },
        created_at: "2030-01-01T12:00:00.000Z",
        expires_at: "2030-01-01T13:00:00.000Z",
      });
    }
    return Response.json({
      id: "refund-1",
      payment_id: "payment-1",
      status: "succeeded",
      amount: { value: "1500.00", currency: "RUB" },
      metadata: { order_id: "order-1" },
    });
  });

  try {
    const provider = new YooKassaProvider("shop", "secret", "https://api.example/v3", 1);
    await provider.createPayment({
      amountMinor: 650000,
      currency: "RUB",
      description: "Paid run — Standard",
      orderId: "order-1",
      returnUrl: "https://club.example/events/1",
      customerPhone: "+79990000000",
      receiptItems: [
        { description: "Standard", quantity: 1, unitAmountMinor: 150000, paymentSubject: "service" },
        { description: "Club T-shirt", quantity: 2, unitAmountMinor: 250000, paymentSubject: "commodity" },
      ],
      idempotenceKey: "payment-key",
    });
    await provider.createRefund({
      paymentId: "payment-1",
      amountMinor: 150000,
      currency: "RUB",
      orderId: "order-1",
      reason: "event_canceled",
      description: "Standard",
      customerPhone: "+79990000000",
      receiptItems: [{ description: "Standard", quantity: 1, unitAmountMinor: 150000, paymentSubject: "service" }],
      idempotenceKey: "refund-key",
    });
    expect(await provider.getRefundsForPayment("payment-1")).toMatchObject([{
      id: "refund-1",
      paymentId: "payment-1",
      amountMinor: 150000,
    }]);

    expect(requests[0]?.headers.get("authorization")).toBe(`Basic ${Buffer.from("shop:secret").toString("base64")}`);
    expect(requests[0]?.headers.get("idempotence-key")).toBe("payment-key");
    expect(requests[0]?.body).toMatchObject({
      capture: true,
      metadata: { order_id: "order-1" },
      receipt: { customer: { phone: "+79990000000" } },
    });
    expect(requests[0]?.body.receipt).toMatchObject({
      items: [
        { description: "Standard", quantity: "1.00", payment_subject: "service" },
        { description: "Club T-shirt", quantity: "2.00", payment_subject: "commodity" },
      ],
    });
    expect(requests[1]?.headers.get("idempotence-key")).toBe("refund-key");
    expect(requests[1]?.body).toMatchObject({
      payment_id: "payment-1",
      metadata: { order_id: "order-1" },
      receipt: { customer: { phone: "+79990000000" } },
    });
    expect(requests[2]?.url).toBe("https://api.example/v3/refunds?payment_id=payment-1&limit=100");
  } finally {
    fetchSpy.mockRestore();
  }
});
