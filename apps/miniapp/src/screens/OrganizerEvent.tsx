import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

import { sku, type AttendanceRow, type EventDraft, type ScannedTicket } from "../api";
import { useI18n } from "../i18n";
import { bib, countdown, errorText, fullDate, fullName } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource, useTicker } from "../lib/useResource";
import { canScan, haptic, scanQr } from "../telegram";
import { CountdownRing, EventStatusChip } from "../ui/event";
import { EventForm } from "../ui/eventForm";
import { EventProductEditor } from "../ui/eventProducts";
import { TicketTierEditor } from "../ui/ticketTiers";
import { Sheet, SheetFooter, useConfirm, useOverlayLock, useToast } from "../ui/overlays";
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
  TelegramUsername,
} from "../ui/primitives";
import { QrCanvas } from "../ui/qr";
import { Backdrop } from "../ui/swoosh";

const TOKEN_WINDOW_MS = 30_000;

/* --------------------------------------------------------------- QR display */

const QrStage = ({ eventId, onClose }: { eventId: number; onClose: () => void }) => {
  const { t } = useI18n();
  const token = useResource(useCallback(() => sku.checkinToken(eventId), [eventId]), { pollMs: TOKEN_WINDOW_MS });
  useOverlayLock();
  const fetchedAt = useRef(Date.now());
  const now = useTicker(1000);

  useEffect(() => {
    if (token.data) fetchedAt.current = Date.now();
  }, [token.data]);

  const remaining = Math.max(0, TOKEN_WINDOW_MS - (now - fetchedAt.current));

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6" style={{ background: "var(--brand)" }}>
      {/* The stage covers the app's own backdrop layer, so it carries its own
          copy of the cropped swooshes. */}
      <Backdrop />
      <div className="relative z-10 flex flex-col items-center gap-5">
        {token.data ? (
          <div className="fade-in">
            <QrCanvas value={token.data.token} size={Math.min(280, window.innerWidth - 96)} />
          </div>
        ) : (
          <div className="grid h-[280px] w-[280px] place-items-center">
            <Loader label={t("common.loading")} />
          </div>
        )}
        <div className="flex items-center gap-3">
          <CountdownRing remaining={remaining} total={TOKEN_WINDOW_MS} size={34} />
          <span className="num text-[11px] tracking-[0.16em] text-hint uppercase">
            {t("organizer.qrRefresh")} {countdown(remaining)}
          </span>
        </div>
        <p className="max-w-[300px] text-center text-[12px] leading-relaxed text-hint">{t("organizer.qrHint")}</p>
      </div>
      <Button variant="ghost" onClick={onClose} className="relative z-10">
        {t("common.close")}
      </Button>
    </div>
  );
};

/* ------------------------------------------------------------------ handover */

type PurchaseLine = AttendanceRow["purchaseItems"][number];

/**
 * One merch line, tappable. It is the same control in the scan panel and in the
 * roster, because it is the same act — the roster copy is what saves a night
 * where someone was let through without a scan.
 */
const HandoverChip = ({
  item,
  pending,
  onToggle,
}: {
  item: PurchaseLine;
  pending: boolean;
  onToggle: () => void;
}) => {
  const handed = item.handedOverAt !== null;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onToggle}
      className={`chip ${handed ? "chip-flare" : "chip-soft"} active:scale-95 ${pending ? "opacity-50" : ""}`}
      style={{ transition: "transform 0.12s" }}
    >
      {handed ? "✓ " : ""}
      {item.name}
      {item.quantity > 1 ? ` ×${item.quantity}` : ""}
    </button>
  );
};

/* --------------------------------------------------------------- scan result */

const ScanPanel = ({
  scanned,
  pending,
  busyItem,
  onHandover,
  onScanAgain,
  onClose,
}: {
  scanned: ScannedTicket;
  pending: boolean;
  busyItem: number | null;
  onHandover: (itemId: number) => void;
  onScanAgain: () => void;
  onClose: () => void;
}) => {
  const { t } = useI18n();
  return (
    <Sheet title={fullName(scanned)} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={scanned.alreadyCheckedIn ? "plain" : "flare"}>
          {scanned.alreadyCheckedIn ? t("organizer.alreadyCheckedIn") : t("organizer.justCheckedIn")}
        </Chip>
        {scanned.ticketName ? <Chip tone="soft">{scanned.ticketName}</Chip> : null}
        {scanned.username ? <TelegramUsername username={scanned.username} /> : null}
      </div>

      <div className="eyebrow mt-5 mb-2">{t("organizer.handoverTitle")}</div>
      {scanned.items.length === 0 ? (
        <p className="text-[13px] text-hint">{t("organizer.nothingToHandOver")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {scanned.items.map((item) => (
            <HandoverChip
              key={item.id}
              item={item}
              pending={busyItem === item.id}
              onToggle={() => onHandover(item.id)}
            />
          ))}
        </div>
      )}

      <SheetFooter>
        <Button block loading={pending} disabled={!canScan()} onClick={onScanAgain}>
          {t("organizer.scanAgain")}
        </Button>
      </SheetFooter>
    </Sheet>
  );
};

/* ------------------------------------------------------------ attendance row */

const PersonRow = ({
  person,
  index,
  pending,
  busyItem,
  onToggle,
  onHandover,
}: {
  person: AttendanceRow;
  index: number;
  pending: boolean;
  busyItem: number | null;
  onToggle: () => void;
  onHandover: (itemId: number) => void;
}) => {
  const { t } = useI18n();
  const togglable = person.status === "registered" || person.status === "checked_in";
  const checked = person.status === "checked_in";

  return (
    <div
      style={{ "--i": index } as React.CSSProperties}
      className={`rise flex items-center gap-3 border-b border-hair px-1 py-3 last:border-b-0 ${checked ? "" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px]">{fullName(person)}</div>
        <div className="num mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-hint">
          {person.username ? <TelegramUsername username={person.username} /> : null}
          {person.phone ? <span className="break-all">{person.phone}</span> : null}
          {person.isStaff ? <Chip tone="soft">{t("status.staff")}</Chip> : null}
          {person.status === "waitlisted" ? <Chip>{t("status.waitlisted")}</Chip> : null}
          {person.status === "canceled" ? <Chip>{t("status.canceled")}</Chip> : null}
          {person.ticketName ? <Chip tone="soft">{person.ticketName}</Chip> : null}
          {person.purchaseItems.map((item) => (
            <HandoverChip
              key={item.id}
              item={item}
              pending={busyItem === item.id}
              onToggle={() => onHandover(item.id)}
            />
          ))}
          {person.paymentStatus && person.paymentStatus !== "fulfilled" ? <Chip>{person.paymentStatus}</Chip> : null}
        </div>
      </div>
      <button
        type="button"
        disabled={!togglable || pending}
        aria-label={t("organizer.manualToggle")}
        onClick={() => {
          haptic.tap(checked ? "light" : "medium");
          onToggle();
        }}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border transition-[transform,background,border-color] duration-150 active:scale-90 ${
          checked ? "border-transparent" : "border-hair"
        } ${togglable ? "" : "opacity-30"}`}
        style={checked ? { background: "var(--flare)", color: "var(--flare-ink)" } : undefined}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden>
          <path
            d="m5 12.5 4.5 4.5L19 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={checked ? 1 : 0.35}
          />
        </svg>
      </button>
    </div>
  );
};

/* -------------------------------------------------------------------- screen */

export const OrganizerEventScreen = () => {
  const { t, locale } = useI18n();
  const params = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  useBackButton("/organizer");

  const id = Number(params.id);
  const [query, setQuery] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingTickets, setEditingTickets] = useState(false);
  const [editingProducts, setEditingProducts] = useState(false);
  const [busyUser, setBusyUser] = useState<number | null>(null);
  const [busyItem, setBusyItem] = useState<number | null>(null);
  const [scanned, setScanned] = useState<ScannedTicket | null>(null);

  const events = useResource(sku.organizerEvents);
  const attendance = useResource(useCallback(() => sku.attendance(id), [id]), { pollMs: 15_000 });

  const event = (events.data ?? []).find((item) => item.id === id) ?? null;
  const over = event?.endedAt != null;
  const counts = attendance.data?.counts ?? null;
  // The server decides which door this event uses; the screen just follows it.
  const ticketed = attendance.data?.ticketed ?? false;

  const rows = (attendance.data?.registrations ?? []).filter((person) => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return true;
    return [fullName(person), person.username ?? "", person.phone ?? ""].join(" ").toLowerCase().includes(needle);
  });

  const toggle = (person: AttendanceRow) => {
    setBusyUser(person.userId);
    void action
      .run(
        async () => {
          const result = await sku.toggleAttendance(id, person.userId);
          attendance.mutate((current) => ({
            ...current,
            registrations: current.registrations.map((row) =>
              row.userId === person.userId
                ? { ...row, status: result.status, checkedInAt: result.status === "checked_in" ? new Date().toISOString() : null }
                : row,
            ),
          }));
          await attendance.reload(true);
        },
        { onError: (error) => toast(errorText(t, error), "err") },
      )
      .finally(() => setBusyUser(null));
  };

  /** Ticking a merch line off, from either the scan panel or the roster. */
  const handover = (itemId: number) => {
    setBusyItem(itemId);
    const patch = (item: PurchaseLine, handedOverAt: string | null) =>
      item.id === itemId ? { ...item, handedOverAt } : item;
    void action
      .run(
        async () => {
          const result = await sku.toggleHandover(id, itemId);
          haptic.tap(result.handedOverAt ? "medium" : "light");
          attendance.mutate((current) => ({
            ...current,
            registrations: current.registrations.map((row) => ({
              ...row,
              purchaseItems: row.purchaseItems.map((item) => patch(item, result.handedOverAt)),
            })),
          }));
          setScanned((current) =>
            current === null ? null : { ...current, items: current.items.map((item) => patch(item, result.handedOverAt)) },
          );
        },
        { onError: (error) => toast(errorText(t, error), "err") },
      )
      .finally(() => setBusyItem(null));
  };

  /**
   * The door on a ticketed run: the runner holds the ticket, so the organizer
   * scans. The panel stays up afterwards because the scan is only half the job —
   * the merch still has to change hands.
   */
  const scan = () =>
    void action.run(
      async () => {
        const code = await scanQr(t("organizer.scanText"));
        if (code === null) return;
        const result = await sku.scanTicket(id, code.trim());
        haptic.notify(result.alreadyCheckedIn ? "warning" : "success");
        setScanned(result);
        await attendance.reload(true);
      },
      {
        onError: (error) => {
          haptic.notify("error");
          toast(errorText(t, error), "err");
        },
      },
    );

  // The class is over when the person running it says so, so ending it is an action
  // here rather than something the start time does on its own.
  const end = async () => {
    if (!(await confirm({ text: t("organizer.confirmEnd"), confirmLabel: t("organizer.endEvent"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.endEvent(id);
        toast(t("organizer.toastEnded"));
        setShowQr(false);
        setScanned(null);
        await Promise.all([events.reload(true), attendance.reload(true)]);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  const reopen = () =>
    void action.run(
      async () => {
        await sku.reopenEvent(id);
        toast(t("organizer.toastReopened"));
        await Promise.all([events.reload(true), attendance.reload(true)]);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const save = (draft: EventDraft) =>
    void action.run(
      async () => {
        await sku.updateEvent(id, draft);
        toast(t("common.saved"));
        setEditing(false);
        await Promise.all([events.reload(true), attendance.reload(true)]);
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

  if (attendance.loading && !attendance.data) {
    return (
      <Screen>
        <Loader label={t("common.loading")} />
      </Screen>
    );
  }

  if (!attendance.data) {
    return (
      <Screen>
        <ErrorState
          message={errorText(t, attendance.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void attendance.reload()}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <PageTitle
        title={event?.title ?? t("organizer.attendance")}
        aside={
          event ? (
            over ? <Chip>{t("organizer.ended")}</Chip> : <EventStatusChip status={event.status} />
          ) : null
        }
      />

      {event ? (
        <p className="mb-4 block truncate text-[13px] text-hint first-letter:uppercase">
          {fullDate(event.startsAt, locale)} · {event.location}
        </p>
      ) : null}

      <section className="rise card mb-4 px-4 py-4">
        <MiniBar
          label={t("organizer.checkedInOf", { a: counts?.checkedIn ?? 0, b: counts?.registered ?? 0 })}
          value={`${counts?.checkedIn ?? 0}/${counts?.registered ?? 0}`}
          ratio={counts && counts.registered > 0 ? counts.checkedIn / counts.registered : 0}
        />
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip tone="soft">
            {t("admin.statRegistered")} {counts?.registered ?? 0}
          </Chip>
          <Chip>
            {t("admin.statWaitlisted")} {counts?.waitlisted ?? 0}
          </Chip>
          {counts?.staff ? (
            <Chip tone="soft">
              {t("organizer.staffCount")} {counts.staffCheckedIn}/{counts.staff}
            </Chip>
          ) : null}
        </div>
      </section>

      {over ? <p className="mb-4 text-[13px] leading-relaxed text-hint">{t("organizer.endedHint")}</p> : null}

      <div className="mb-4 flex flex-wrap gap-2">
        {over ? (
          <Button block loading={action.pending} onClick={reopen}>
            {t("organizer.reopenEvent")}
          </Button>
        ) : ticketed ? (
          <Button block loading={action.pending} disabled={!canScan()} onClick={scan}>
            {t("organizer.scanTickets")}
          </Button>
        ) : (
          <Button block onClick={() => setShowQr(true)}>
            {t("organizer.showQr")}
          </Button>
        )}
        <Button variant="ghost" onClick={() => setEditing(true)}>
          {t("common.edit")}
        </Button>
        {event ? (
          <Button variant="ghost" onClick={() => setEditingTickets(true)}>
            {t("tickets.title")} · {event.ticketTiers.filter((tier) => tier.active).length}
          </Button>
        ) : null}
        {event ? (
          <Button variant="ghost" onClick={() => setEditingProducts(true)}>
            {t("products.title")} · {event.products.filter((product) => product.active).length}
          </Button>
        ) : null}
      </div>

      {ticketed && !over ? (
        <p className="mb-4 text-[13px] leading-relaxed text-hint">
          {canScan() ? t("organizer.scanHint") : t("checkin.unavailable")}
        </p>
      ) : null}

      {over ? null : (
        <Button variant="ghost" block className="mb-4" loading={action.pending} onClick={() => void end()}>
          {t("organizer.endEvent")}
        </Button>
      )}

      <SearchInput
        className="mb-2"
        placeholder={t("organizer.searchPeople")}
        value={query}
        onChange={(event_) => setQuery(event_.target.value)}
      />

      <section className="card px-4 py-1">
        {rows.length === 0 ? (
          <EmptyState text={query ? t("common.nothing") : t("organizer.noRegistrations")} />
        ) : (
          rows.map((person, index) => (
            <PersonRow
              key={person.userId}
              person={person}
              index={index}
              pending={busyUser === person.userId}
              busyItem={busyItem}
              onToggle={() => toggle(person)}
              onHandover={handover}
            />
          ))
        )}
      </section>

      {showQr ? <QrStage eventId={id} onClose={() => setShowQr(false)} /> : null}

      {scanned ? (
        <ScanPanel
          scanned={scanned}
          pending={action.pending}
          busyItem={busyItem}
          onHandover={handover}
          onScanAgain={scan}
          onClose={() => setScanned(null)}
        />
      ) : null}

      {editing ? (
        <Sheet title={t("organizer.edit")} onClose={() => setEditing(false)}>
          <EventForm
            cities={event?.city ? [event.city] : []}
            initial={
              event
                ? {
                    city: event.city,
                    title: event.title,
                    description: event.description,
                    startsAt: event.startsAt,
                    location: event.location,
                    locationUrl: event.locationUrl,
                    capacity: event.capacity,
                  }
                : {}
            }
            submitLabel={t("common.save")}
            pending={action.pending}
            onSubmit={save}
          />
        </Sheet>
      ) : null}
      {editingTickets && event ? (
        <Sheet title={t("tickets.title")} onClose={() => setEditingTickets(false)}>
          <TicketTierEditor initial={event.ticketTiers} pending={action.pending} onSave={saveTickets} />
        </Sheet>
      ) : null}
      {editingProducts && event ? (
        <Sheet title={t("products.title")} onClose={() => setEditingProducts(false)}>
          <EventProductEditor initial={event.products} pending={action.pending} onSave={saveProducts} />
        </Sheet>
      ) : null}
    </Screen>
  );
};
