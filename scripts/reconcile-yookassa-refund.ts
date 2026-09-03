// Reconciles a refund that was created directly in the YooKassa dashboard.
// The refund is fetched from YooKassa and matched to the local order through its
// provider payment id; no local status is trusted as proof of the refund.
//
// Preview (remote read only):
//   docker compose exec -T app bun run scripts/reconcile-yookassa-refund.ts <refund-or-payment-id>
// Apply:
//   docker compose exec -T app bun run scripts/reconcile-yookassa-refund.ts <refund-or-payment-id> --apply
import { createDb } from "../packages/db/src/client";

import { reconcileRefund } from "../apps/server/src/core/tickets";
import { PaymentProviderError, type ProviderRefund } from "../apps/server/src/payments/provider";
import { YooKassaProvider } from "../apps/server/src/payments/yookassa";

const suppliedId = process.argv[2];
const apply = process.argv.slice(3).includes("--apply");
if (!suppliedId) {
  console.error("Usage: bun run scripts/reconcile-yookassa-refund.ts <refund-or-payment-id> [--apply]");
  process.exit(1);
}

const shopId = process.env.YOOKASSA_SHOP_ID;
const secretKey = process.env.YOOKASSA_SECRET_KEY;
if (!shopId || !secretKey) {
  console.error("YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY must be configured.");
  process.exit(1);
}

const provider = new YooKassaProvider(shopId, secretKey);
const db = createDb(process.env.DATABASE_PATH ?? "./data/sku.db");

type MatchRow = {
  order_id: string;
  event_id: number;
  user_id: number;
  order_status: string;
  amount_minor: number;
  currency: string;
};

const localOrderForPayment = (paymentId: string) => db.$client.query<MatchRow, [string]>(`
  SELECT
    o.id AS order_id,
    o.event_id,
    o.user_id,
    o.status AS order_status,
    o.amount_minor,
    o.currency
  FROM payment_attempts a
  JOIN ticket_orders o ON o.id = a.order_id
  WHERE a.provider_payment_id = ? AND a.status = 'succeeded'
`).get(paymentId);

const resolveRefund = async (): Promise<ProviderRefund> => {
  try {
    return await provider.getRefund(suppliedId);
  } catch (error) {
    if (!(error instanceof PaymentProviderError) || error.status !== 404) throw error;
  }

  const localOrder = localOrderForPayment(suppliedId);
  const refunds = await provider.getRefundsForPayment(suppliedId);
  if (refunds.length === 0) {
    throw new Error(
      `ЮKassa found neither refund ${suppliedId} nor any refunds for payment ${suppliedId}. `
      + "Check the ID and make sure this container uses the same test/production shop that processed it.",
    );
  }

  console.log(`The supplied value is not a refund ID; ЮKassa found ${refunds.length} refund(s) for it as a payment ID.`);
  console.table(refunds.map((refund) => ({
    refund_id: refund.id,
    status: refund.status,
    amount_minor: refund.amountMinor,
    currency: refund.currency,
  })));
  if (!localOrder) throw new Error(`No succeeded local payment matches YooKassa payment ${suppliedId}.`);
  const full = refunds.filter((refund) =>
    refund.amountMinor === localOrder.amount_minor && refund.currency === localOrder.currency
  );
  if (full.length !== 1) {
    throw new Error(`Expected exactly one full refund for payment ${suppliedId}, found ${full.length}; nothing was changed.`);
  }
  return full[0]!;
};

try {
  const remote = await resolveRefund();
  const match = localOrderForPayment(remote.paymentId);

  console.log("YooKassa refund:");
  console.table([{
    refund_id: remote.id,
    payment_id: remote.paymentId,
    status: remote.status,
    amount_minor: remote.amountMinor,
    currency: remote.currency,
  }]);
  if (!match) throw new Error(`No succeeded local payment matches YooKassa payment ${remote.paymentId}.`);
  console.log("Matched local order:");
  console.table([match]);
  if (remote.amountMinor !== match.amount_minor || remote.currency !== match.currency) {
    throw new Error("This is not a full refund of the matched order; nothing was changed.");
  }

  if (!apply) {
    console.log("Preview only: YooKassa was read, but the local database was not changed.");
    console.log("Run the same command with --apply to reconcile this refund.");
  } else {
    const effects = await reconcileRefund(db, provider, remote.id, new Date());
    const status = db.$client.query<{ status: string }, [string]>(
      "SELECT status FROM ticket_orders WHERE id = ?",
    ).get(match.order_id)?.status;
    console.log(`Reconciled order ${match.order_id}; local status is now ${status}.`);
    if (effects.length > 0) console.log("Notifications generated:", effects);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  db.$client.close();
}
