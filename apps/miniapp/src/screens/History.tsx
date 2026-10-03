import { useNavigate } from "react-router";

import { sku, type PurchaseOrder } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { dayMonth, errorText, fullDate, money } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource } from "../lib/useResource";
import { openLink } from "../telegram";
import { useConfirm, useToast } from "../ui/overlays";
import { Button, Chip, EmptyState, ErrorState, Loader, PageTitle, Screen, SectionRule } from "../ui/primitives";

const statusKey: Record<PurchaseOrder["status"], MessageKey> = {
  awaiting_payment: "purchases.status.awaiting_payment",
  payment_succeeded: "purchases.status.payment_succeeded",
  fulfilled: "purchases.status.fulfilled",
  cancel_pending: "purchases.status.cancel_pending",
  canceled: "purchases.status.canceled",
  refund_pending: "purchases.status.refund_pending",
  refunded: "purchases.status.refunded",
  refund_failed: "purchases.status.refund_failed",
};

const pendingOrder = (order: PurchaseOrder) => order.status === "awaiting_payment" || order.status === "cancel_pending";

/** Every run done and every purchase made, reached from Mine and from Profile. */
export const HistoryScreen = () => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  useBackButton("/mine");
  const runs = useResource(sku.history);
  const orders = useResource(sku.orders, { pollMs: 20_000 });
  const action = useAction();
  const confirm = useConfirm();
  const toast = useToast();

  const cancelOrder = async (order: PurchaseOrder) => {
    if (!(await confirm({ text: t("purchases.cancelConfirm"), confirmLabel: t("purchases.cancel"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.cancelOrder(order.orderId);
        toast(t("purchases.canceledToast"));
        await orders.reload(true);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  const purchases = orders.data ?? [];
  const done = runs.data ?? [];

  return (
    <Screen>
      <PageTitle title={t("history.title")} />

      {(runs.loading && !runs.data) || (orders.loading && !orders.data) ? <Loader label={t("common.loading")} /> : null}
      {orders.error && !orders.data ? (
        <ErrorState message={errorText(t, orders.error)} retryLabel={t("common.retry")} onRetry={() => void orders.reload()} />
      ) : null}
      {runs.data && orders.data && purchases.length + done.length === 0 ? <EmptyState text={t("history.empty")} /> : null}

      {purchases.length > 0 ? (
        <>
          <SectionRule label={t("purchases.title")} />
          <div className="flex flex-col gap-3">
            {purchases.map((order) => (
              <article key={order.orderId} className="card px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" className="min-w-0 text-left" onClick={() => navigate(`/events/${order.event.id}`)}>
                    <h2 className="text-[15px] leading-tight font-semibold">{order.event.title}</h2>
                    <p className="mt-1 text-[11px] text-hint first-letter:uppercase">{fullDate(order.event.startsAt, locale)}</p>
                  </button>
                  <Chip tone={order.status === "fulfilled" ? "soft" : pendingOrder(order) ? "flare" : "plain"}>{t(statusKey[order.status])}</Chip>
                </div>
                <div className="hairline my-3" />
                <div className="flex flex-col gap-1.5">
                  {order.items.map((item, index) => (
                    <div key={`${item.kind}-${item.name}-${index}`} className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="min-w-0 break-words">
                        {item.name}
                        {item.variantName ? ` · ${item.variantName}` : ""}
                        {item.quantity > 1 ? ` × ${item.quantity}` : ""}
                      </span>
                      <span className="num shrink-0 text-[12px] text-hint">{money(item.unitAmountMinor * item.quantity, locale, order.currency)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="eyebrow">{t("purchases.total")}</span>
                  <span className="num text-[15px]">{money(order.amountMinor, locale, order.currency)}</span>
                </div>
                {order.status === "awaiting_payment" ? (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button size="sm" disabled={!order.confirmationUrl} onClick={() => order.confirmationUrl && openLink(order.confirmationUrl)}>
                      {t("purchases.continue")}
                    </Button>
                    <Button variant="danger" size="sm" loading={action.pending} onClick={() => void cancelOrder(order)}>
                      {t("purchases.cancel")}
                    </Button>
                  </div>
                ) : null}
                {order.status === "cancel_pending" ? <p className="mt-3 text-[12px] text-hint">{t("purchases.cancelPending")}</p> : null}
              </article>
            ))}
          </div>
        </>
      ) : null}

      {done.length > 0 ? (
        <>
          <SectionRule label={t("history.runs")} />
          <div className="card">
            {done.map((run) => (
              <div key={run.id} className="row">
                <span className="num w-11 shrink-0 text-[12px] text-hint">{dayMonth(run.startsAt, locale)}</span>
                <span className="min-w-0 flex-1 truncate text-[14px]">{run.title}</span>
                <Chip tone={run.status === "checked_in" ? "soft" : "plain"}>{t(run.status === "checked_in" ? "status.checked_in" : "mine.missed")}</Chip>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Screen>
  );
};
