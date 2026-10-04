import { useCallback, useState } from "react";

import type { CitySlug } from "@sku/cities";

import { sku, type AdminPurchaseOrder } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { errorText, fullDate, fullName, money, percent } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { Sheet, SheetFooter, useConfirm, useToast } from "./overlays";
import { Button, Chip, EmptyState, ErrorState, Loader, SearchInput, TelegramUsername } from "./primitives";

/* ---------------------------------------------------------------- event stats */

/** The full numbers the old admin screen kept: offers, conversion and staff included. */
export const StatsSheet = ({ eventId, capacity, onClose }: { eventId: number; capacity: number | null; onClose: () => void }) => {
  const { t } = useI18n();
  const stats = useResource(useCallback(() => sku.eventStats(eventId), [eventId]));
  const data = stats.data;
  const rows: ReadonlyArray<{ label: string; value: string; hint?: string }> = data
    ? [
        { label: t("admin.statRegistered"), value: String(data.registered), hint: capacity === null ? t("events.freeEntry") : `${t("common.of")} ${capacity}` },
        { label: t("admin.statCheckedIn"), value: String(data.checkedIn), hint: data.staff ? `${t("organizer.staffCount")} ${data.staffCheckedIn}/${data.staff}` : undefined },
        { label: t("admin.statWaitlisted"), value: String(data.waitlisted) },
        { label: t("admin.statNoShow"), value: String(data.registered - data.checkedIn), hint: percent(data.noShowRate) },
        { label: t("admin.statAttendance"), value: percent(data.attendanceRate) },
        { label: t("admin.statConversion"), value: percent(data.waitlistConversion), hint: t("admin.statOffers", { a: data.offersAccepted, b: data.offersMade }) },
      ]
    : [];
  return (
    <Sheet title={t("admin.stats")} onClose={onClose}>
      {data ? (
        <section className="card">
          {rows.map((row) => (
            <div key={row.label} className="row">
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold">{row.label}</span>
                {row.hint ? <span className="block text-[12px] text-hint">{row.hint}</span> : null}
              </span>
              <span className="num text-[15px]">{row.value}</span>
            </div>
          ))}
        </section>
      ) : stats.loading ? (
        <Loader label={t("common.loading")} />
      ) : (
        <ErrorState message={errorText(t, stats.error)} retryLabel={t("common.retry")} onRetry={() => void stats.reload()} />
      )}
    </Sheet>
  );
};

/* ------------------------------------------------------- organizer assignment */

export const OrganizersSheet = ({ eventId, onClose }: { eventId: number; onClose: () => void }) => {
  const { t } = useI18n();
  const toast = useToast();
  const action = useAction();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const users = useResource(useCallback(() => sku.users(query.trim() || undefined), [query]));

  const save = () =>
    void action.run(
      async () => {
        await sku.setOrganizers(eventId, picked);
        toast(t("common.saved"));
        onClose();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  return (
    <Sheet title={t("admin.organizers")} onClose={onClose}>
      <p className="mb-3 text-[12px] leading-relaxed text-hint">{t("admin.organizersHint")}</p>
      <SearchInput
        className="mb-3"
        placeholder={t("common.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="mb-4 max-h-[45dvh] overflow-y-auto">
        {(users.data ?? []).map((person) => {
          const active = picked.includes(person.id);
          return (
            <div key={person.id} className="flex w-full items-center gap-3 border-b border-hair last:border-b-0">
              <button
                type="button"
                onClick={() =>
                  setPicked((prev) => (active ? prev.filter((id) => id !== person.id) : [...prev, person.id]))
                }
                className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left"
              >
                <span
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-md border"
                  style={
                    active
                      ? { background: "var(--flare)", borderColor: "transparent", color: "var(--flare-ink)" }
                      : { borderColor: "var(--hair)" }
                  }
                >
                  {active ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px]">{fullName(person)}</span>
              </button>
              {person.username ? <TelegramUsername username={person.username} className="num shrink-0 text-[11px] text-hint" /> : null}
            </div>
          );
        })}
      </div>
      <SheetFooter>
        <Button block loading={action.pending} disabled={picked.length === 0} onClick={save}>
          {t("common.save")} · {picked.length}
        </Button>
      </SheetFooter>
    </Sheet>
  );
};

/**
 * Filing one run under a series after the fact. The deploy backfill groups the
 * copy-pasted history it can recognise, but it only ever groups two or more
 * identical runs — a session that was renamed, or the first of a new habit,
 * lands here instead, and without this its numbers would sit outside the series
 * analytics forever.
 */
export const SeriesSheet = ({
  eventId,
  city,
  current,
  onClose,
  onChanged,
}: {
  eventId: number;
  city: CitySlug;
  current: number | null;
  onClose: () => void;
  onChanged: () => void;
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const action = useAction();
  const series = useResource(sku.series);
  // A run may only join a series of its own branch; the server enforces it too.
  const options = (series.data ?? []).filter((row) => row.city === city);

  const choose = (seriesId: number | null) =>
    void action.run(
      async () => {
        await (seriesId === null ? sku.detachFromSeries(eventId) : sku.attachToSeries(eventId, seriesId));
        toast(t(seriesId === null ? "toast.detached" : "toast.attached"));
        onClose();
        onChanged();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  return (
    <Sheet title={t("series.attachTitle")} onClose={onClose}>
      <p className="mb-4 text-[12px] leading-snug text-hint">{t("series.attachHint")}</p>
      {series.loading && !series.data ? <Loader label={t("common.loading")} /> : null}
      {series.data && options.length === 0 ? <EmptyState text={t("series.empty")} /> : null}
      <div className="flex flex-col gap-2">
        {options.map((row) => (
          <button
            key={row.id}
            type="button"
            disabled={action.pending}
            onClick={() => choose(row.id)}
            className={`card flex items-center justify-between gap-3 px-4 py-3 text-left active:scale-[0.985] ${
              row.id === current ? "card-mine pl-5" : ""
            }`}
          >
            <span className="min-w-0">
              <span className="display block truncate text-[14px]">{row.title}</span>
              <span className="block truncate text-[12px] text-hint">{row.location}</span>
            </span>
            {row.id === current ? <Chip tone="flare">{t("series.inSeries")}</Chip> : null}
          </button>
        ))}
      </div>
      {current === null ? null : (
        <Button block variant="danger" size="sm" className="mt-4" loading={action.pending} onClick={() => choose(null)}>
          {t("series.detach")}
        </Button>
      )}
    </Sheet>
  );
};

const purchaseStatusKey: Record<AdminPurchaseOrder["status"], MessageKey> = {
  awaiting_payment: "purchases.status.awaiting_payment",
  payment_succeeded: "purchases.status.payment_succeeded",
  fulfilled: "purchases.status.fulfilled",
  cancel_pending: "purchases.status.cancel_pending",
  canceled: "purchases.status.canceled",
  refund_pending: "purchases.status.refund_pending",
  refunded: "purchases.status.refunded",
  refund_failed: "purchases.status.refund_failed",
};

/** Every order on the event, with the refund an admin can still start. */
export const PurchasesSheet = ({ eventId, onClose, onChanged }: { eventId: number; onClose: () => void; onChanged: () => void }) => {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const purchases = useResource(useCallback(() => sku.eventPurchases(eventId), [eventId]), { pollMs: 15_000 });
  const price = (minor: number, currency: string) => money(minor, locale, currency);

  const refundOrder = async (order: AdminPurchaseOrder) => {
    const amount = price(order.amountMinor, order.currency);
    if (!(await confirm({ text: t("admin.refundConfirm", { name: fullName(order.buyer), amount }), confirmLabel: t("admin.refundOrder"), danger: true }))) return;
    setBusyOrder(order.orderId);
    void action
      .run(
        async () => {
          await sku.refundEventOrder(eventId, order.orderId);
          toast(t("admin.refundRequested"));
          await purchases.reload(true);
          onChanged();
        },
        { onError: (error) => toast(errorText(t, error), "err") },
      )
      .finally(() => setBusyOrder(null));
  };

  return (
    <Sheet title={t("manage.purchases")} onClose={onClose} full>
      {purchases.loading && !purchases.data ? <Loader label={t("common.loading")} /> : null}
      {purchases.error && !purchases.data ? (
        <ErrorState message={errorText(t, purchases.error)} retryLabel={t("common.retry")} onRetry={() => void purchases.reload()} />
      ) : null}
      {purchases.data?.orders.length === 0 ? <EmptyState text={t("admin.noPurchases")} /> : null}
      {purchases.data && purchases.data.orders.length > 0 ? (
        <div className="flex flex-col gap-3">
          {purchases.data.orders.map((order) => (
            <article key={order.orderId} className="card px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-[15px] font-semibold">{fullName(order.buyer)}</h2>
                  <div className="num mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-hint">
                    {order.buyer.username ? <TelegramUsername username={order.buyer.username} /> : null}
                    {order.buyer.phone ? <span>{order.buyer.phone}</span> : null}
                    <span>#{order.orderId.slice(0, 8)}</span>
                  </div>
                  <div className="mt-2">
                    <Chip tone={order.includesTicket ? "soft" : "plain"}>
                      {t(order.includesTicket ? "admin.purchaseIncludesTicket" : "admin.purchaseOnly")}
                    </Chip>
                  </div>
                </div>
                <Chip tone={order.status === "fulfilled" ? "soft" : order.status === "refund_pending" ? "flare" : "plain"}>
                  {t(purchaseStatusKey[order.status])}
                </Chip>
              </div>
              <p className="mt-2 text-[11px] text-hint">{t("admin.boughtAt", { date: fullDate(order.createdAt, locale) })}</p>
              <div className="hairline my-3" />
              <div className="flex flex-col gap-1.5">
                {order.items.map((item, itemIndex) => (
                  <div key={`${order.orderId}-${itemIndex}`} className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="min-w-0 break-words">
                      {item.name}{item.variantName ? ` · ${item.variantName}` : ""}{item.quantity > 1 ? ` × ${item.quantity}` : ""}
                    </span>
                    <span className="num shrink-0 text-[12px] text-hint">
                      {price(item.unitAmountMinor * item.quantity, order.currency)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="eyebrow">{t("purchases.total")}</span>
                <span className="num text-[15px]">{price(order.amountMinor, order.currency)}</span>
              </div>
              {order.refundFailureReason ? (
                <p className="mt-2 text-[12px] text-hint">{t("admin.refundFailure", { reason: order.refundFailureReason })}</p>
              ) : null}
              {order.refundable ? (
                <Button
                  block
                  size="sm"
                  variant="danger"
                  className="mt-3"
                  disabled={purchases.data?.paymentsConfigured !== true}
                  loading={busyOrder === order.orderId}
                  onClick={() => void refundOrder(order)}
                >
                  {t("admin.refundOrder")}
                </Button>
              ) : null}
              {order.refundable && purchases.data?.paymentsConfigured !== true ? (
                <p className="mt-2 text-[11px] text-hint">{t("admin.refundsUnavailable")}</p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

    </Sheet>
  );
};
