export type ProviderPaymentStatus = "pending" | "succeeded" | "canceled";
export type ProviderRefundStatus = "pending" | "succeeded" | "canceled";

export type ProviderPayment = {
  id: string;
  status: ProviderPaymentStatus;
  amountMinor: number;
  currency: string;
  metadata: Record<string, string>;
  confirmationUrl: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export type ProviderRefund = {
  id: string;
  paymentId: string;
  status: ProviderRefundStatus;
  amountMinor: number;
  currency: string;
  failureReason: string | null;
  metadata: Record<string, string>;
};

export type PaymentReceiptItem = {
  description: string;
  quantity: number;
  unitAmountMinor: number;
  paymentSubject: "service" | "commodity";
};

export interface PaymentProvider {
  readonly requiresCustomerContact: boolean;
  createPayment(input: {
    amountMinor: number;
    currency: "RUB";
    description: string;
    orderId: string;
    returnUrl: string;
    idempotenceKey: string;
    customerPhone?: string;
    receiptItems: PaymentReceiptItem[];
  }): Promise<ProviderPayment>;
  getPayment(paymentId: string): Promise<ProviderPayment>;
  cancelPayment(paymentId: string, idempotenceKey: string): Promise<ProviderPayment>;
  createRefund(input: {
    paymentId: string;
    amountMinor: number;
    currency: "RUB";
    orderId: string;
    reason: string;
    description: string;
    customerPhone?: string;
    receiptItems: PaymentReceiptItem[];
    idempotenceKey: string;
  }): Promise<ProviderRefund>;
  getRefund(refundId: string): Promise<ProviderRefund>;
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
