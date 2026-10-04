import { useNavigate } from "react-router";

import { sku, type EventCard as EventCardData, type PurchaseOrder } from "../api";
import { useI18n } from "../i18n";
import { countdown, dayMonth, errorText, monthSince, money } from "../lib/format";
import { useAction, useResource, useTicker } from "../lib/useResource";
import { haptic, openLink } from "../telegram";
import { CountdownRing, EventCard } from "../ui/event";
import { useConfirm, useToast } from "../ui/overlays";
import { Button, Chip, EmptyState, ErrorState, Loader, PageTitle, Screen } from "../ui/primitives";

const OFFER_WINDOW_MS = 20 * 60 * 1000;
const RECENT_RUNS = 3;

/**
 * What is yours: on top only what waits for an answer — a spot on offer, a
 * payment left open — then the runs ahead, then a short tail of runs done.
 * Purchases live in History; Mine is about what happens next.
 */
export const MineScreen = () => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const events = useResource(sku.events, { pollMs: 60_000 });
  const orders = useResource(sku.orders, { pollMs: 20_000 });
  const history = useResource(sku.history);

  const list = events.data ?? [];
  const offers = list.filter((event) => event.myPendingOffer !== null);
  const ahead = list.filter(
    (event) => event.myPendingOffer === null && event.myRegistrationStatus !== null && event.myRegistrationStatus !== "canceled",
  );
  const unpaid = (orders.data ?? []).filter((order) => order.status === "awaiting_payment");
  const done = history.data ?? [];
  const firstRun = done.at(-1);
  const reloadAll = () => Promise.all([events.reload(true), orders.reload(true)]).then(() => undefined);

  const loading = (events.loading && !events.data) || (orders.loading && !orders.data);
  const empty = events.data && orders.data && history.data && offers.length + ahead.length + unpaid.length + done.length === 0;

  return (
    <Screen>
      <PageTitle title={t("mine.title")} />

      {loading ? <Loader label={t("common.loading")} /> : null}
      {events.error && !events.data ? (
        <ErrorState message={errorText(t, events.error)} retryLabel={t("common.retry")} onRetry={() => void events.reload()} />
      ) : null}
      {/* Payments left open come from here; losing them silently would hide a debt. */}
      {orders.error && !orders.data ? (
        <ErrorState message={errorText(t, orders.error)} retryLabel={t("common.retry")} onRetry={() => void orders.reload()} />
      ) : null}

      {empty ? (
        <EmptyState
          text={t("mine.empty")}
          action={
            <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
              {t("mine.goToEvents")}
            </Button>
          }
        />
      ) : null}

      <div className="flex flex-col gap-2.5">
        {offers.map((event) => (
          <OfferCard key={event.id} event={event} onDone={reloadAll} />
        ))}
        {unpaid.map((order) => (
          <UnpaidRow key={order.orderId} order={order} />
        ))}
      </div>

      {ahead.length > 0 ? (
        <>
          <Rule label={t("mine.upcoming")} aside={String(ahead.length)} />
          <div className="flex flex-col gap-3">
            {ahead.map((event, index) => (
              <EventCard key={event.id} event={event} index={index} />
            ))}
          </div>
        </>
      ) : null}

      {firstRun ? (
        <>
          <Rule label={t("mine.done")} aside={t("mine.doneSince", { since: monthSince(firstRun.startsAt, locale), n: done.length })} />
          <div className="card rise">
            {done.slice(0, RECENT_RUNS).map((run) => (
              <div key={run.id} className="row">
                <span className="num w-11 shrink-0 text-[12px] text-hint">{dayMonth(run.startsAt, locale)}</span>
                <span className="min-w-0 flex-1 truncate text-[14px]">{run.title}</span>
                <Chip tone={run.status === "checked_in" ? "soft" : "plain"}>
                  {t(run.status === "checked_in" ? "status.checked_in" : "mine.missed")}
                </Chip>
              </div>
            ))}
            <button type="button" className="row" onClick={() => navigate("/history")}>
              <span className="flex-1 text-[13px] text-hint">{t("mine.allHistory")}</span>
              <span className="chev">›</span>
            </button>
          </div>
        </>
      ) : orders.data && orders.data.length > 0 ? (
        <button type="button" className="card row mt-7" onClick={() => navigate("/history")}>
          <span className="flex-1 text-[13px] text-hint">{t("mine.allHistory")}</span>
          <span className="chev">›</span>
        </button>
      ) : null}
    </Screen>
  );
};

const Rule = ({ label, aside }: { label: string; aside?: string }) => (
  <div className="mt-[26px] mb-3 flex items-center gap-3">
    <span className="eyebrow shrink-0">{label}</span>
    <span className="hairline flex-1" />
    {aside ? <span className="num shrink-0 text-[11px] text-hint">{aside}</span> : null}
  </div>
);

/** A spot came free: the ring runs down the twenty minutes it is held for you. */
const OfferCard = ({ event, onDone }: { event: EventCardData; onDone: () => Promise<void> }) => {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  const now = useTicker(1000);
  const offer = event.myPendingOffer;
  if (!offer) return null;
  const remaining = Math.max(0, new Date(offer.expiresAt).getTime() - now);

  const accept = () =>
    void action.run(
      async () => {
        await sku.acceptOffer(offer.id);
        haptic.notify("success");
        toast(t("offer.accepted"));
        await onDone();
      },
      {
        onError: (error) => {
          toast(errorText(t, error), "err");
          void onDone();
        },
      },
    );

  // Passing on the spot means leaving the queue: staying in it would only offer
  // the same spot straight back.
  const decline = async () => {
    if (!(await confirm({ text: t("offer.declineConfirm"), confirmLabel: t("offer.decline"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.cancel(event.id);
        toast(t("toast.canceled"));
        await onDone();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  return (
    <article className="card rise p-4">
      <div className="flex items-center gap-3.5">
        <CountdownRing remaining={remaining} total={OFFER_WINDOW_MS} size={58}>
          <span className="num text-[12px]">{countdown(remaining)}</span>
        </CountdownRing>
        <div className="min-w-0 flex-1">
          <div className="mb-1">
            <Chip tone="flare">{t("status.offer")}</Chip>
          </div>
          <h3 className="display truncate text-[15px]">{event.title}</h3>
          <p className="mt-0.5 text-[12px] text-hint">{remaining > 0 ? t("offer.body") : t("offer.expired")}</p>
        </div>
      </div>
      <div className="mt-3.5 grid grid-cols-[1fr_2fr] gap-2">
        <Button variant="ghost" size="sm" disabled={action.pending} onClick={() => void decline()}>
          {t("offer.decline")}
        </Button>
        <Button size="sm" loading={action.pending} onClick={accept}>
          {t("action.accept")}
        </Button>
      </div>
    </article>
  );
};

const UnpaidRow = ({ order }: { order: PurchaseOrder }) => {
  const { t, locale } = useI18n();
  return (
    <div className="card rise flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="eyebrow mb-0.5">{t("purchases.status.awaiting_payment")}</div>
        <div className="truncate text-[13px]">
          {order.event.title} · <span className="num">{money(order.amountMinor, locale, order.currency)}</span>
        </div>
      </div>
      <Button variant="solid" size="sm" disabled={!order.confirmationUrl} onClick={() => order.confirmationUrl && openLink(order.confirmationUrl)}>
        {t("purchases.pay")}
      </Button>
    </div>
  );
};
