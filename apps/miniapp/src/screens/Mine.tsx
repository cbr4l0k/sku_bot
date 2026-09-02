import { useNavigate } from "react-router";

import { sku, type PurchaseOrder } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { errorText, fullDate } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { openLink } from "../telegram";
import { EventCard } from "../ui/event";
import { useConfirm, useToast } from "../ui/overlays";
import { Button, Chip, EmptyState, ErrorState, Loader, PageTitle, Screen, SectionRule } from "../ui/primitives";

const pendingOrder = (order: PurchaseOrder) => order.status === "awaiting_payment" || order.status === "cancel_pending";
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

export const MineScreen = () => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const events = useResource(sku.events, { pollMs: 60_000 });
  const orders = useResource(sku.orders, { pollMs: 20_000 });
  const action = useAction();
  const confirm = useConfirm();
  const toast = useToast();

  const mine = (events.data ?? []).filter(
    (event) =>
      (event.myRegistrationStatus !== null && event.myRegistrationStatus !== "canceled") ||
      event.myPendingOffer !== null,
  );

  const checkedIn = mine.filter((event) => event.myRegistrationStatus === "checked_in");
  const ahead = mine.filter((event) => event.myRegistrationStatus !== "checked_in");
  const purchases = orders.data ?? [];
  const price = (minor: number, currency: string) => new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);

  const cancelOrder = async (order: PurchaseOrder) => {
    if (!(await confirm({ text: t("purchases.cancelConfirm"), confirmLabel: t("purchases.cancel"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.cancelOrder(order.orderId);
        toast(t("purchases.canceledToast"));
        await Promise.all([orders.reload(true), events.reload(true)]);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  return (
    <Screen>
      <PageTitle title={t("mine.title")} />

      {(events.loading && !events.data) || (orders.loading && !orders.data) ? <Loader label={t("common.loading")} /> : null}
      {events.error && !events.data ? (
        <ErrorState
          message={errorText(t, events.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void events.reload()}
        />
      ) : null}

      {orders.error && !orders.data ? (
        <ErrorState
          message={errorText(t, orders.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void orders.reload()}
        />
      ) : null}

      {events.data && orders.data && mine.length === 0 && purchases.length === 0 ? (
        <EmptyState
          text={t("mine.empty")}
          action={
            <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
              {t("mine.goToEvents")}
            </Button>
          }
        />
      ) : null}

      {purchases.length > 0 ? (
        <>
          <SectionRule label={t("purchases.title")} />
          <div className="flex flex-col gap-3">
            {purchases.map((order) => (
              <article key={order.orderId} className="card px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" className="min-w-0 text-left" onClick={() => navigate(`/events/${order.event.id}`)}>
                    <h2 className="text-[15px] font-semibold leading-tight">{order.event.title}</h2>
                    <p className="mt-1 text-[11px] text-hint first-letter:uppercase">{fullDate(order.event.startsAt, locale)}</p>
                  </button>
                  <Chip tone={order.status === "fulfilled" ? "soft" : pendingOrder(order) ? "flare" : "plain"}>
                    {t(statusKey[order.status])}
                  </Chip>
                </div>
                <div className="hairline my-3" />
                <div className="flex flex-col gap-1.5">
                  {order.items.map((item, index) => (
                    <div key={`${item.kind}-${item.name}-${index}`} className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="min-w-0 break-words">
                        {item.name}{item.variantName ? ` · ${item.variantName}` : ""}{item.quantity > 1 ? ` × ${item.quantity}` : ""}
                      </span>
                      <span className="num shrink-0 text-[12px] text-hint">{price(item.unitAmountMinor * item.quantity, order.currency)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="eyebrow">{t("purchases.total")}</span>
                  <span className="num text-[15px]">{price(order.amountMinor, order.currency)}</span>
                </div>
                {order.status === "awaiting_payment" ? (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      disabled={!order.confirmationUrl}
                      onClick={() => order.confirmationUrl && openLink(order.confirmationUrl)}
                    >
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

      {ahead.length > 0 ? (
        <>
          <SectionRule label={t("mine.upcoming")} />
          <div className="flex flex-col gap-3">
            {ahead.map((event, index) => (
              <EventCard key={event.id} event={event} index={index} />
            ))}
          </div>
        </>
      ) : null}

      {checkedIn.length > 0 ? (
        <>
          <SectionRule label={t("status.checked_in")} />
          <div className="flex flex-col gap-3">
            {checkedIn.map((event, index) => (
              <EventCard key={event.id} event={event} index={index} />
            ))}
          </div>
        </>
      ) : null}
    </Screen>
  );
};
