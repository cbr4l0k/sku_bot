import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router";

import type { CitySlug } from "@sku/cities";

import { sku, type AdminEventDraft, type AdminPurchaseOrder, type EventStatus } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { bib, errorText, fullDate, fullName, percent } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource } from "../lib/useResource";
import { copyText } from "../telegram";
import { EventStatusChip } from "../ui/event";
import { EventForm } from "../ui/eventForm";
import { EventProductEditor } from "../ui/eventProducts";
import { GroupChips } from "../ui/groups";
import { TicketTierEditor } from "../ui/ticketTiers";
import { Sheet, SheetFooter, useConfirm, useToast } from "../ui/overlays";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Loader,
  MiniBar,
  PageTitle,
  Screen,
  SearchInput,
  SectionRule,
  StatTile,
  TelegramUsername,
} from "../ui/primitives";

/* ------------------------------------------------------- organizer assignment */

const OrganizersSheet = ({ eventId, onClose }: { eventId: number; onClose: () => void }) => {
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

/* -------------------------------------------------------------------- screen */

/**
 * Filing one run under a series after the fact. The deploy backfill groups the
 * copy-pasted history it can recognise, but it only ever groups two or more
 * identical runs — a session that was renamed, or the first of a new habit,
 * lands here instead, and without this its numbers would sit outside the series
 * analytics forever.
 */
const SeriesSheet = ({
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

export const AdminEventScreen = () => {
  const { t, locale } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  useBackButton("/admin");

  const id = Number(params.id);
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [editingTickets, setEditingTickets] = useState(false);
  const [editingProducts, setEditingProducts] = useState(false);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const events = useResource(sku.organizerEvents);
  const stats = useResource(useCallback(() => sku.eventStats(id), [id]));
  const purchases = useResource(useCallback(() => sku.eventPurchases(id), [id]), { pollMs: 15_000 });
  const seriesList = useResource(sku.series);

  const event = (events.data ?? []).find((item) => item.id === id) ?? null;

  // Only this event's own branch has chats it may use.
  const eventCity = event?.city ?? null;
  const catalog = useResource(
      useCallback(
          () => (eventCity ? sku.groupCatalog(eventCity) : Promise.resolve({ groups: [] })),
          [eventCity],
      ),
      { enabled: eventCity !== null },
  );

  const patch = (body: Partial<AdminEventDraft> & { status?: EventStatus }) =>
    void action.run(
      async () => {
        await sku.adminUpdateEvent(id, body);
        toast(t("common.saved"));
        setEditing(false);
        await Promise.all([events.reload(true), stats.reload(true)]);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const toggleQueue = async () => {
    if (event?.waitlistEnabled) {
      const waiting = stats.data?.waitlisted ?? 0;
      const text = waiting > 0 ? t("admin.confirmDisableQueueWaiting", { n: waiting }) : t("admin.confirmDisableQueue");
      if (!(await confirm({ text, confirmLabel: t("admin.disableQueue"), danger: true }))) return;
    }
    patch({ waitlistEnabled: !event?.waitlistEnabled });
  };

  // Ending is deliberately separate from the status: it says the event has run, and
  // it is the only thing that closes check-in.
  const endOrReopen = async () => {
    if (event?.endedAt == null && !(await confirm({ text: t("organizer.confirmEnd"), confirmLabel: t("organizer.endEvent"), danger: true }))) return;
    void action.run(
      async () => {
        const ended = event?.endedAt == null;
        await (ended ? sku.endEvent(id) : sku.reopenEvent(id));
        toast(t(ended ? "organizer.toastEnded" : "organizer.toastReopened"));
        await Promise.all([events.reload(true), stats.reload(true)]);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  const cancelEvent = async () => {
    const text = t(event?.ticketTiers.length ? "admin.confirmCancelPaid" : "admin.confirmCancel");
    if (!(await confirm({ text, confirmLabel: t("admin.cancelEvent"), danger: true }))) return;
    patch({ status: "canceled" });
  };

  const removeEvent = async () => {
    if (!(await confirm({ text: t("admin.confirmDelete"), confirmLabel: t("common.delete"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.deleteEvent(id);
        navigate("/admin", { replace: true });
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  const copyLink = () =>
    void action.run(
      async () => {
        const link = await sku.eventLink(id);
        // The bot link works without a registered Mini App short name, and answers
        // with the event card and its sign-up button.
        await copyText(link.botLink);
        toast(t("common.copied"));
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const saveTickets = (tiers: Parameters<typeof sku.setTicketTiers>[1]) =>
    void action.run(
      async () => {
        await sku.setTicketTiers(id, tiers);
        toast(t("common.saved"));
        setEditingTickets(false);
        await events.reload(true);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const saveProducts = (products: Parameters<typeof sku.setProducts>[1]) =>
    void action.run(
      async () => {
        await sku.setProducts(id, products);
        toast(t("common.saved"));
        setEditingProducts(false);
        await events.reload(true);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const price = (minor: number, currency: string) => new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);

  const refundOrder = async (order: AdminPurchaseOrder) => {
    const amount = price(order.amountMinor, order.currency);
    if (!(await confirm({
      text: t("admin.refundConfirm", { name: fullName(order.buyer), amount }),
      confirmLabel: t("admin.refundOrder"),
      danger: true,
    }))) return;
    setBusyOrder(order.orderId);
    void action.run(
      async () => {
        await sku.refundEventOrder(id, order.orderId);
        toast(t("admin.refundRequested"));
        await Promise.all([purchases.reload(true), stats.reload(true)]);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    ).finally(() => setBusyOrder(null));
  };

  if (events.loading && !events.data) {
    return (
      <Screen>
        <Loader label={t("common.loading")} />
      </Screen>
    );
  }

  if (!event) {
    return (
      <Screen>
        <ErrorState message={t("err.event_not_found")} retryLabel={t("common.retry")} onRetry={() => void events.reload()} />
      </Screen>
    );
  }

  const data = stats.data;
  const noShow = data ? Math.max(0, data.registered - data.checkedIn) : 0;

  return (
    <Screen>
      <PageTitle
        title={event.title}
        aside={event.endedAt ? <Chip>{t("organizer.ended")}</Chip> : <EventStatusChip status={event.status} />}
      />

      <div className="mb-4">
        <p className="block truncate text-[13px] text-hint first-letter:uppercase">
          {fullDate(event.startsAt, locale)} · {event.location}
        </p>
        {event.groups.length > 0 || event.homeChat !== null || !event.waitlistEnabled ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {event.groups.length > 0 ? <span className="text-[11px] text-hint">{t("form.groups")}</span> : null}
            <GroupChips groups={event.groups} />
            {event.homeChat === null ? null : (
              <>
                <span className="text-[11px] text-hint">{t("form.homeChat")}</span>
                <Chip tone="soft">{event.homeChat.title}</Chip>
              </>
            )}
            {event.waitlistEnabled ? null : <Chip tone="plain">{t("admin.queueOff")}</Chip>}
          </div>
        ) : null}
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        {event.status !== "published" ? (
          <Button size="sm" loading={action.pending} onClick={() => patch({ status: "published" })}>
            {t("admin.publish")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" loading={action.pending} onClick={() => patch({ status: "closed" })}>
            {t("admin.close")}
          </Button>
        )}
        {event.status === "draft" || event.status === "canceled" ? null : (
          <Button size="sm" variant="ghost" loading={action.pending} onClick={() => void endOrReopen()}>
            {event.endedAt ? t("organizer.reopenEvent") : t("organizer.endEvent")}
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={action.pending} onClick={() => void toggleQueue()}>
          {event.waitlistEnabled ? t("admin.disableQueue") : t("admin.enableQueue")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {t("common.edit")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAssigning(true)}>
          {t("admin.organizers")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditingTickets(true)}>
          {t("tickets.title")} · {event.ticketTiers.filter((tier) => tier.active).length}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditingProducts(true)}>
          {t("products.title")} · {event.products.filter((product) => product.active).length}
        </Button>
        <Button size="sm" variant="ghost" loading={action.pending} onClick={copyLink}>
          ⧉ {t("admin.copyLink")}
        </Button>
        <Button size="sm" variant="danger" loading={action.pending} onClick={() => void removeEvent()}>
          {t("admin.deleteEvent")}
        </Button>
        {event.status !== "canceled" ? (
          <Button size="sm" variant="danger" loading={action.pending} onClick={() => void cancelEvent()}>
            {t("admin.cancelEvent")}
          </Button>
        ) : null}
      </div>

      <SectionRule label={t("series.title")} />
      <button
        type="button"
        onClick={() => setLinking(true)}
        className="card flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left active:scale-[0.985]"
      >
        <span className="min-w-0 text-[14px]">
          {event.seriesId === null
            ? t("series.attach")
            : ((seriesList.data ?? []).find((row) => row.id === event.seriesId)?.title ?? t("series.inSeries"))}
        </span>
        <span className="eyebrow shrink-0">{event.seriesId === null ? "+" : "\u203A"}</span>
      </button>

      <SectionRule label={t("admin.stats")} />

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label={t("admin.statRegistered")}
              value={String(data.registered)}
              hint={event.capacity === null ? t("events.freeEntry") : `${t("common.of")} ${event.capacity}`}
            />
            <StatTile
              label={t("admin.statCheckedIn")}
              value={String(data.checkedIn)}
              /* Staff check in too, but they are not part of the number above —
                 they never took a spot to attend. */
              hint={data.staff ? `${t("organizer.staffCount")} ${data.staffCheckedIn}/${data.staff}` : undefined}
            />
            <StatTile label={t("admin.statWaitlisted")} value={String(data.waitlisted)} />
            <StatTile label={t("admin.statNoShow")} value={String(noShow)} hint={percent(data.noShowRate)} />
          </div>
          <section className="card mt-3 px-4 py-4">
            <MiniBar label={t("admin.statAttendance")} value={percent(data.attendanceRate)} ratio={data.attendanceRate} />
            <MiniBar
              label={t("admin.statConversion")}
              value={percent(data.waitlistConversion)}
              ratio={data.waitlistConversion}
            />
            <div className="mt-2">
              <Chip>{t("admin.statOffers", { a: data.offersAccepted, b: data.offersMade })}</Chip>
            </div>
          </section>
        </>
      ) : (
        <Loader label={t("common.loading")} />
      )}

      <SectionRule label={t("admin.purchases")} />

      {purchases.loading && !purchases.data ? <Loader label={t("common.loading")} /> : null}
      {purchases.error && !purchases.data ? (
        <ErrorState
          message={errorText(t, purchases.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void purchases.reload()}
        />
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

      {editing ? (
        <Sheet title={t("common.edit")} onClose={() => setEditing(false)}>
          <EventForm
            cities={event.city ? [event.city] : []}
            initial={{
              city: event.city,
              title: event.title,
              description: event.description,
              startsAt: event.startsAt,
              location: event.location,
              locationUrl: event.locationUrl,
              capacity: event.capacity,
              groups: event.groups.map((group) => group.id),
              homeChatId: event.homeChat?.id ?? null,
            }}
            submitLabel={t("common.save")}
            pending={action.pending}
            availableGroups={catalog.data?.groups ?? []}
            onSubmit={(draft) => patch(draft)}
          />
        </Sheet>
      ) : null}

      {assigning ? <OrganizersSheet eventId={id} onClose={() => setAssigning(false)} /> : null}
      {editingTickets ? (
        <Sheet title={t("tickets.title")} onClose={() => setEditingTickets(false)}>
          <TicketTierEditor initial={event.ticketTiers} pending={action.pending} onSave={saveTickets} />
        </Sheet>
      ) : null}
      {editingProducts ? (
        <Sheet title={t("products.title")} onClose={() => setEditingProducts(false)}>
          <EventProductEditor initial={event.products} pending={action.pending} onSave={saveProducts} />
        </Sheet>
      ) : null}
    </Screen>
  );
};
