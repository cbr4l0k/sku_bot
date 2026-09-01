import { loadEnv } from "../env";
import type { PaymentProvider } from "./provider";
import { YooKassaProvider } from "./yookassa";

const env = loadEnv();

export const paymentProvider: PaymentProvider | null = env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY
  ? new YooKassaProvider(env.YOOKASSA_SHOP_ID, env.YOOKASSA_SECRET_KEY, undefined, env.YOOKASSA_VAT_CODE)
  : null;

export const paymentsConfigured = paymentProvider !== null;
export * from "./provider";
