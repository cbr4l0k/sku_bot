import { useCallback, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router";

import { CITIES } from "@sku/cities";

import { sku, type AdminEventDraft, type AttendanceRow, type EventDraft, type EventPhase, type EventStatus, type EventSummary, type EventSummaryData, type ScannedTicket } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { errorText, fullName, money, percent, shortDate, timeOf } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource } from "../lib/useResource";
import { canScan, copyText, haptic, scanQr } from "../telegram";
import { OrganizersSheet, PurchasesSheet, SeriesSheet, StatsSheet } from "../ui/eventAdmin";
import { EventForm } from "../ui/eventForm";
import { EventProductEditor } from "../ui/eventProducts";
import { Dialog, Sheet, SheetFooter, useConfirm, useToast } from "../ui/overlays";
import { Button, Chip, ErrorState, Field, Loader, Screen, SearchInput, TextInput } from "../ui/primitives";
import { HandoverChip, owedItems, QrStage, RosterRow, RosterSheet, ScanDialog } from "../ui/roster";
import { TicketTierEditor } from "../ui/ticketTiers";

/** Old links into the two retired event screens land on the one that replaced them. */
export const ManageRedirect = () => {
  const { id } = useParams();
  return <Navigate to={`/hq/events/${id}`} replace />;
};

type Overlay =
  | "basics"
  | "spots"
  | "tickets"
  | "tiers"
  | "products"
  | "admin-form"
  | "organizers"
  | "series"
  | "purchases"
  | "stats"
  | "roster"
  | "cancel"
  | "qr";

const PHASES: ReadonlyArray<{ phase: Exclude<EventPhase, "canceled">; key: MessageKey }> = [
  { phase: "draft", key: "phase.draft" },
  { phase: "signup", key: "phase.signup" },
  { phase: "start", key: "phase.start" },
  { phase: "wrapup", key: "phase.wrapup" },
];

/**
 * One screen for an event's whole life — draft, sign-up, start, wrap-up. The bar
 * on top says where it is; the body below is only what that phase needs.
 */
export const EventManageScreen = () => {
  const { t, locale } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  useBackButton("/hq");
  const id = Number(params.id);

  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [busyUser, setBusyUser] = useState<number | null>(null);
  const [busyItem, setBusyItem] = useState<number | null>(null);
  const [scanned, setScanned] = useState<ScannedTicket | null>(null);

  const events = useResource(sku.organizerEvents);
  const summary = useResource(useCallback(() => sku.eventSummary(id), [id]), { pollMs: 15_000 });
  const attendance = useResource(useCallback(() => sku.attendance(id), [id]), { pollMs: 15_000 });
  const event = (events.data ?? []).find((item) => item.id === id) ?? null;
  const catalog = useResource(
    useCallback(() => (event ? sku.groupCatalog(event.city) : Promise.resolve({ groups: [] })), [event]),
    { enabled: event !== null && summary.data?.canCancel === true },
  );

  const refresh = async () => {
    await Promise.all([events.reload(true), summary.reload(true), attendance.reload(true)]);
  };
  const run = (task: () => Promise<unknown>, done: string, after?: () => void) =>
    void action.run(
      async () => {
        await task();
        toast(done);
        after?.();
        await refresh();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  if (!summary.data || !attendance.data || !event) {
    const failed = summary.error ?? attendance.error ?? events.error ?? (events.data && !event ? new Error("event_not_found") : null);
    return (
      <Screen>
        {failed && !summary.loading ? (
          <ErrorState message={errorText(t, failed)} retryLabel={t("common.retry")} onRetry={() => void refresh()} />
        ) : (
          <Loader label={t("common.loading")} />
        )}
      </Screen>
    );
  }

  const info = summary.data;
  const roster = attendance.data.registrations;
  const canAdmin = info.canCancel;
  const phase = info.phase;
  const ticketed = info.ticketed;

  const toggle = (person: AttendanceRow) => {
    setBusyUser(person.userId);
    haptic.tap(person.status === "checked_in" ? "light" : "medium");
    void action
      .run(
        async () => {
          await sku.toggleAttendance(id, person.userId);
          await Promise.all([attendance.reload(true), summary.reload(true)]);
        },
        { onError: (error) => toast(errorText(t, error), "err") },
      )
      .finally(() => setBusyUser(null));
  };

  const handover = (itemId: number) => {
    setBusyItem(itemId);
    void action
      .run(
        async () => {
          const result = await sku.toggleHandover(id, itemId);
          haptic.tap(result.handedOverAt ? "medium" : "light");
          const patch = <T extends { id: number; handedOverAt: string | null }>(item: T): T =>
            item.id === itemId ? { ...item, handedOverAt: result.handedOverAt } : item;
          attendance.mutate((current) => ({
            ...current,
            registrations: current.registrations.map((row) => ({ ...row, purchaseItems: row.purchaseItems.map(patch) })),
          }));
          setScanned((current) => (current ? { ...current, items: current.items.map(patch) } : null));
          void summary.reload(true);
        },
        { onError: (error) => toast(errorText(t, error), "err") },
      )
      .finally(() => setBusyItem(null));
  };

  const scan = () =>
    void action.run(
      async () => {
        setScanned(null);
        const code = await scanQr(t("organizer.scanText"));
        if (code === null) return;
        const result = await sku.scanTicket(id, code.trim());
        haptic.notify(result.alreadyCheckedIn ? "warning" : "success");
        setScanned(result);
        await Promise.all([attendance.reload(true), summary.reload(true)]);
      },
      {
        onError: (error) => {
          haptic.notify("error");
          toast(errorText(t, error), "err");
        },
      },
    );

  const end = async () => {
    if (!(await confirm({ text: t("organizer.confirmEnd"), confirmLabel: t("organizer.endEvent"), danger: true }))) return;
    run(() => sku.endEvent(id), t("organizer.toastEnded"), () => setScanned(null));
  };

  const adminPatch = (body: Partial<AdminEventDraft> & { status?: EventStatus }, done = t("common.saved")) =>
    run(() => sku.adminUpdateEvent(id, body), done, () => setOverlay(null));

  const copyLink = () =>
    void action.run(
      async () => {
        const link = await sku.eventLink(id);
        await copyText(link.botLink);
        toast(t("common.copied"));
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const removeEvent = async () => {
    if (!(await confirm({ text: t("admin.confirmDelete"), confirmLabel: t("common.delete"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.deleteEvent(id);
        navigate("/hq", { replace: true });
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  const confirmedRows = roster.filter((person) => !person.isStaff && (person.status === "registered" || person.status === "checked_in"));
  const waitlisted = roster.filter((person) => person.status === "waitlisted");
  const capacityLeft = event.capacity === null ? null : Math.max(0, event.capacity - info.counts.registered - event.pendingTicketCount);
  const position = scanned ? { n: info.counts.checkedIn, total: info.counts.registered } : null;

  return (
    <Screen>
      <div className="eyebrow mb-2.5 truncate">
        {shortDate(event.startsAt, locale)} · {timeOf(event.startsAt, locale)} · {event.location}
      </div>
      <h1 className="hero rise mb-5 break-words">{event.title}</h1>
      <PhaseBar phase={phase} />

      {phase === "canceled" ? (
        <NowCard text={t("manage.nowCanceled")}>
          <div className={`grid gap-2 ${canAdmin ? "grid-cols-2" : ""}`}>
            <Button size="sm" variant="ghost" onClick={() => setOverlay("roster")}>
              {t("manage.allRunners")}
            </Button>
            {canAdmin ? (
              <Button size="sm" loading={action.pending} onClick={() => adminPatch({ status: "published" }, t("hq.published"))}>
                {t("admin.publish")}
              </Button>
            ) : null}
          </div>
        </NowCard>
      ) : phase === "draft" ? (
        <NowCard text={t(canAdmin ? "manage.nowDraft" : "manage.nowDraftOrganizer")}>
          {canAdmin ? (
            <Button size="sm" block loading={action.pending} onClick={() => adminPatch({ status: "published" }, t("hq.published"))}>
              {t("hq.publish")}
            </Button>
          ) : null}
        </NowCard>
      ) : phase === "signup" ? (
        <NowCard text={signupLine(t, info, event.capacity, capacityLeft)}>
          {event.capacity !== null ? <Gauge value={info.counts.registered} max={event.capacity} left={capacityLeft ?? 0} /> : null}
          {canAdmin ? (
            <div className="mt-3.5 grid grid-cols-2 gap-2">
              <Button size="sm" loading={action.pending} onClick={copyLink}>
                {t("manage.link")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={action.pending}
                onClick={() => adminPatch({ status: info.signupClosed ? "published" : "closed" })}
              >
                {t(info.signupClosed ? "manage.reopenSignup" : ticketed ? "manage.closeSales" : "manage.closeSignup")}
              </Button>
            </div>
          ) : null}
        </NowCard>
      ) : phase === "wrapup" ? (
        <NowCard text={t("manage.nowWrapup", { time: event.endedAt ? timeOf(event.endedAt, locale) : "—" })}>
          <div className="mt-3.5 grid grid-cols-2 gap-2">
            <Button size="sm" onClick={() => setOverlay("roster")}>
              {t("manage.fixList")}
            </Button>
            <Button size="sm" variant="ghost" loading={action.pending} onClick={() => run(() => sku.reopenEvent(id), t("organizer.toastReopened"))}>
              {t("organizer.reopenEvent")}
            </Button>
          </div>
        </NowCard>
      ) : null}

      {phase === "start" ? (
        <StartDoor
          info={info}
          roster={roster}
          ticketed={ticketed}
          pending={action.pending}
          busyUser={busyUser}
          busyItem={busyItem}
          onScan={scan}
          onShowQr={() => setOverlay("qr")}
          onToggle={toggle}
          onHandover={handover}
          onRoster={() => setOverlay("roster")}
          onEnd={() => void end()}
        />
      ) : null}

      {/* The door opens on its own an hour ahead; before that it can still be
          opened, or the event ended, by hand. */}
      {phase === "signup" ? (
        <section className="card mt-3">
          {ticketed ? (
            canScan() ? <LinkRow label={t("organizer.scanTickets")} onPress={scan} /> : null
          ) : (
            <LinkRow label={t("organizer.showQr")} onPress={() => setOverlay("qr")} />
          )}
          <LinkRow label={t("organizer.endEvent")} onPress={() => void end()} />
        </section>
      ) : null}

      {phase === "wrapup" ? <WrapUp info={info} /> : null}

      {phase === "signup" && ticketed ? (
        <>
          <Rule label={t("manage.sales")} aside={info.money ? money(info.money.revenueMinor, locale) : undefined} />
          <section className="card rise">
            {event.ticketTiers.filter((tier) => tier.active).map((tier) => (
              <SalesRow
                key={`tier-${tier.id}`}
                name={tier.name}
                hint={[money(tier.priceMinor, locale), tier.quota === null ? t("manage.noLimit") : tier.description].filter(Boolean).join(" · ")}
                sold={tier.claimed}
                quota={tier.quota}
              />
            ))}
            {event.products.filter((product) => product.active).map((product) => (
              <SalesRow
                key={`product-${product.id}`}
                name={product.name}
                hint={[money(product.priceMinor, locale), product.variants.filter((variant) => variant.active).map((variant) => variant.name).join(", ")].filter(Boolean).join(" · ")}
                sold={product.claimed}
                quota={product.stock}
              />
            ))}
            {canAdmin ? <LinkRow label={t("manage.purchases")} onPress={() => setOverlay("purchases")} /> : null}
          </section>
        </>
      ) : null}

      {phase === "signup" || phase === "draft" ? (
        confirmedRows.length + waitlisted.length > 0 ? (
          <>
            <Rule label={t("manage.runners")} aside={waitlisted.length ? `${confirmedRows.length} + ${waitlisted.length}` : String(confirmedRows.length)} />
            <section className="card rise">
              {confirmedRows.slice(0, 2).map((person) => (
                <RosterRow key={person.userId} person={person} pending={false} />
              ))}
              <LinkRow label={t("manage.allRunners")} onPress={() => setOverlay("roster")} />
            </section>
          </>
        ) : null
      ) : null}

      <Rule label={phase === "draft" ? t("manage.checkBefore") : t("manage.settings")} />
      <Settings
        event={event}
        info={info}
        canAdmin={canAdmin}
        phase={phase}
        onOpen={setOverlay}
        pending={action.pending}
        onToggleReminders={() => run(() => sku.updateEvent(id, { remindersEnabled: !event.remindersEnabled }), t("common.saved"))}
      />

      {/* What the old admin screen offered at any hour stays reachable in every
          phase; the phase only decides what is up front. */}
      {canAdmin ? (
        <>
          <Rule label={t("manage.adminActions")} />
          <section className="card">
            <LinkRow label={t("admin.stats")} onPress={() => setOverlay("stats")} />
            {ticketed ? <LinkRow label={t("manage.purchases")} onPress={() => setOverlay("purchases")} /> : null}
            {phase !== "signup" ? <LinkRow label={t("manage.link")} onPress={copyLink} /> : null}
            {phase === "start" ? (
              <LinkRow
                label={t(info.signupClosed ? "manage.reopenSignup" : ticketed ? "manage.closeSales" : "manage.closeSignup")}
                onPress={() => adminPatch({ status: info.signupClosed ? "published" : "closed" })}
              />
            ) : null}
            {/* The server refuses an event with money on it; it says so in the toast. */}
            <DangerRow label={t(phase === "draft" ? "manage.deleteDraft" : "admin.deleteEvent")} onPress={() => void removeEvent()} />
            {phase !== "canceled" ? <DangerRow label={t("admin.cancelEvent")} onPress={() => setOverlay("cancel")} /> : null}
          </section>
        </>
      ) : null}

      {/* ------------------------------------------------------------ overlays */}

      {overlay === "qr" ? <QrStage eventId={id} onClose={() => setOverlay(null)} /> : null}

      {scanned ? (
        <ScanDialog
          scanned={scanned}
          position={position}
          pending={action.pending}
          busyItem={busyItem}
          onHandover={handover}
          onNext={scan}
          onClose={() => setScanned(null)}
        />
      ) : null}

      {overlay === "roster" ? (
        <RosterSheet
          title={phase === "wrapup" ? t("manage.fixList") : t("manage.allRunners")}
          rows={roster}
          busyUser={busyUser}
          busyItem={busyItem}
          onToggle={toggle}
          onHandover={handover}
          onClose={() => setOverlay(null)}
        />
      ) : null}

      {overlay === "cancel" ? (
        <Dialog
          role="alertdialog"
          eyebrow={`${shortDate(event.startsAt, locale)} · ${event.title}`}
          title={t("manage.cancelTitle")}
          onClose={() => setOverlay(null)}
        >
          <div className="card my-[18px] bg-white">
            <div className="row text-[14px] leading-[1.45]">
              <span>
                <b>{t("manage.cancelWho", { n: info.cancelPreview.registered, w: info.cancelPreview.waitlisted })}</b> {t("manage.cancelNotified")}
              </span>
            </div>
            <div className="row text-[14px] leading-[1.45]">{t(ticketed ? "manage.cancelRefunds" : "manage.cancelCard")}</div>
            <div className="row text-[14px] leading-[1.45]">{t("manage.cancelFinal")}</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="ghost" onClick={() => setOverlay(null)}>
              {t("manage.keepEvent")}
            </Button>
            <Button variant="danger" loading={action.pending} onClick={() => adminPatch({ status: "canceled" }, t("manage.canceled"))}>
              {t("admin.cancelEvent")}
            </Button>
          </div>
        </Dialog>
      ) : null}

      {overlay === "basics" ? (
        <Sheet title={t("manage.basics")} onClose={() => setOverlay(null)}>
          <EventForm
            cities={[event.city]}
            initial={{
              city: event.city,
              title: event.title,
              description: event.description,
              startsAt: event.startsAt,
              location: event.location,
              locationUrl: event.locationUrl,
              capacity: event.capacity,
            }}
            submitLabel={t("common.save")}
            pending={action.pending}
            onSubmit={(draft: EventDraft) => run(() => sku.updateEvent(id, draft), t("common.saved"), () => setOverlay(null))}
          />
        </Sheet>
      ) : null}

      {overlay === "admin-form" ? (
        <Sheet title={t("manage.visibility")} onClose={() => setOverlay(null)}>
          <EventForm
            cities={[event.city]}
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
            onSubmit={(draft) => adminPatch(draft)}
          />
        </Sheet>
      ) : null}

      {overlay === "spots" ? (
        <SpotsSheet
          capacity={event.capacity}
          waitlistEnabled={event.waitlistEnabled}
          waiting={info.counts.waitlisted}
          pending={action.pending}
          onClose={() => setOverlay(null)}
          onSave={(body) => run(() => sku.updateEvent(id, body), t("common.saved"), () => setOverlay(null))}
        />
      ) : null}

      {overlay === "tickets" ? (
        <Sheet title={t("manage.ticketsAndMerch")} onClose={() => setOverlay(null)}>
          <div className="card">
            <LinkRow label={`${t("tickets.title")} · ${event.ticketTiers.filter((tier) => tier.active).length}`} onPress={() => setOverlay("tiers")} />
            <LinkRow label={`${t("products.title")} · ${event.products.filter((product) => product.active).length}`} onPress={() => setOverlay("products")} />
          </div>
        </Sheet>
      ) : null}
      {overlay === "tiers" ? (
        <Sheet title={t("tickets.title")} onClose={() => setOverlay(null)}>
          <TicketTierEditor
            initial={event.ticketTiers}
            pending={action.pending}
            onSave={(tiers) => run(() => sku.setTicketTiers(id, tiers), t("common.saved"), () => setOverlay(null))}
          />
        </Sheet>
      ) : null}
      {overlay === "products" ? (
        <Sheet title={t("products.title")} onClose={() => setOverlay(null)}>
          <EventProductEditor
            initial={event.products}
            pending={action.pending}
            onSave={(products) => run(() => sku.setProducts(id, products), t("common.saved"), () => setOverlay(null))}
          />
        </Sheet>
      ) : null}

      {overlay === "organizers" ? (
        <OrganizersSheet
          eventId={id}
          onClose={() => {
            setOverlay(null);
            void refresh();
          }}
        />
      ) : null}
      {overlay === "series" ? (
        <SeriesSheet eventId={id} city={event.city} current={event.seriesId} onClose={() => setOverlay(null)} onChanged={() => void refresh()} />
      ) : null}
      {overlay === "stats" ? <StatsSheet eventId={id} capacity={event.capacity} onClose={() => setOverlay(null)} /> : null}
      {overlay === "purchases" ? <PurchasesSheet eventId={id} onClose={() => setOverlay(null)} onChanged={() => void refresh()} /> : null}
    </Screen>
  );
};

/* ------------------------------------------------------------------- pieces */

const signupLine = (
  t: ReturnType<typeof useI18n>["t"],
  info: EventSummaryData,
  capacity: number | null,
  left: number | null,
): string => {
  if (info.signupClosed) return t("manage.nowClosed");
  if (info.ticketed) return capacity === null ? t("manage.nowSoldOpen", { n: info.counts.registered }) : t("manage.nowSold", { n: info.counts.registered, total: capacity });
  if (left === 0) return info.counts.waitlisted ? t("manage.nowFullQueue", { n: info.counts.waitlisted }) : t("manage.nowFull");
  const days = Math.floor(info.minutesToStart / (60 * 24));
  return days >= 1 ? t("manage.nowOpenDays", { n: days }) : t("manage.nowOpenToday");
};

/** Draft → Sign-up → Start → Wrap-up, with everything up to now filled in. */
const PhaseBar = ({ phase }: { phase: EventPhase }) => {
  const { t } = useI18n();
  const current = PHASES.findIndex((item) => item.phase === phase);
  return (
    <ol className="mb-4 grid grid-cols-4 gap-1.5" aria-label={t("manage.phases")}>
      {PHASES.map((item, index) => {
        const state = current === -1 ? "later" : index < current ? "done" : index === current ? "now" : "later";
        return (
          <li key={item.phase} aria-current={state === "now" ? "step" : undefined}>
            <div
              className="mb-[7px] h-[5px] rounded-full"
              style={{ background: state === "done" ? "var(--ink-deep)" : state === "now" ? "var(--flare)" : "var(--veil)" }}
            />
            <div className="num text-[9px] tracking-[0.12em] uppercase" style={{ color: "var(--ink-deep)", opacity: state === "later" ? 0.7 : 1 }}>
              {t(item.key)}
            </div>
          </li>
        );
      })}
    </ol>
  );
};

const NowCard = ({ text, children }: { text: string; children?: ReactNode }) => {
  const { t } = useI18n();
  return (
    <section className="card rise p-4">
      <div className="eyebrow mb-2.5">{t("manage.now")}</div>
      <p className={`text-[14px] ${children ? "mb-3.5" : ""}`}>{text}</p>
      {children}
    </section>
  );
};

const Gauge = ({ value, max, left }: { value: number; max: number; left: number }) => {
  const { t } = useI18n();
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="num text-[11px] tracking-[0.14em] text-hint uppercase">{left === 0 ? t("events.full") : t("events.spotsLeft", { n: left })}</span>
        <span className="num text-[11px]">
          {value}/{max}
        </span>
      </div>
      <div className={`track ${value >= max ? "track-full" : ""}`}>
        <div className="track-fill" style={{ width: `${Math.min(100, (value / Math.max(max, 1)) * 100)}%` }} />
      </div>
    </div>
  );
};

const Rule = ({ label, aside }: { label: string; aside?: string }) => (
  <div className="mt-[26px] mb-3 flex items-center gap-3">
    <span className="eyebrow shrink-0">{label}</span>
    <span className="hairline flex-1" />
    {aside ? <span className="num shrink-0 text-[11px] text-hint">{aside}</span> : null}
  </div>
);

const LinkRow = ({ label, onPress }: { label: string; onPress: () => void }) => (
  <button type="button" className="row" onClick={onPress}>
    <span className="flex-1 text-[13px]">{label}</span>
    <span className="chev">›</span>
  </button>
);

const DangerRow = ({ label, onPress }: { label: string; onPress: () => void }) => (
  <button type="button" className="row" onClick={onPress} style={{ color: "var(--danger)" }}>
    <span className="flex-1 text-[13px] font-semibold">{label}</span>
    <span className="chev" style={{ color: "inherit" }}>›</span>
  </button>
);

const SalesRow = ({ name, hint, sold, quota }: { name: string; hint: string; sold: number; quota: number | null }) => (
  <div className="row block">
    <div className="flex items-baseline gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">{name}</div>
        {hint ? <div className="text-[12px] text-hint">{hint}</div> : null}
      </div>
      <span className="num text-[13px]">{quota === null ? sold : `${sold}/${quota}`}</span>
    </div>
    {quota !== null ? (
      <div className="track mt-2 h-1.5">
        <div className="track-fill" style={{ width: `${Math.min(100, (sold / Math.max(quota, 1)) * 100)}%` }} />
      </div>
    ) : null}
  </div>
);

/** The settings rows; the ones only a branch admin may change say so. */
const Settings = ({
  event,
  info,
  canAdmin,
  phase,
  onOpen,
  pending,
  onToggleReminders,
}: {
  event: EventSummary;
  info: EventSummaryData;
  canAdmin: boolean;
  phase: EventPhase;
  onOpen: (overlay: Overlay) => void;
  pending: boolean;
  onToggleReminders: () => void;
}) => {
  const { t, locale } = useI18n();
  const tiers = event.ticketTiers.filter((tier) => tier.active).length;
  const products = event.products.filter((product) => product.active).length;
  const chats = [event.homeChat?.title, ...event.groups.map((group) => group.title)].filter((title, index, all) => title && all.indexOf(title) === index);
  const rows: ReadonlyArray<{ key: MessageKey; value: string; overlay: Overlay; admin?: boolean }> = [
    { key: "manage.basics", value: `${shortDate(event.startsAt, locale)}, ${timeOf(event.startsAt, locale)} · ${event.location}`, overlay: "basics" },
    {
      key: "manage.spots",
      value: [event.capacity === null ? t("manage.noLimit") : t("manage.spotsN", { n: event.capacity }), t(event.waitlistEnabled ? "series.waitlistOn" : "series.waitlistOff")].join(" · "),
      overlay: "spots",
    },
    {
      key: "manage.ticketsAndMerch",
      value:
        tiers === 0 && products === 0
          ? t("manage.freeNoMerch")
          : [tiers ? t("manage.tiersN", { n: tiers }) : t("events.free"), products ? t("manage.productsN", { n: products }) : t("manage.noMerch")].join(" · "),
      overlay: "tickets",
    },
    { key: "manage.chat", value: chats.join(", ") || "—", overlay: "admin-form", admin: true },
    ...(phase === "signup" && !canAdmin
      ? []
      : ([
          {
            key: "manage.visibility",
            value: event.groups.length ? event.groups.map((group) => group.title).join(", ") : t("manage.everyone", { city: CITIES[event.city].name[locale] }),
            overlay: "admin-form",
            admin: true,
          },
          { key: "admin.organizers", value: info.organizers.map(fullName).join(", ") || "—", overlay: "organizers", admin: true },
          { key: "series.title", value: event.seriesId === null ? t("series.attach") : t("series.inSeries"), overlay: "series", admin: true },
        ] as const)),
  ];
  return (
    <section className="card rise">
      {rows.map((row) => {
        const locked = row.admin && !canAdmin;
        return (
          <button key={`${row.key}-${row.overlay}`} type="button" className="row" disabled={locked} onClick={() => onOpen(row.overlay)}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[14px] font-semibold">
                {t(row.key)}
                {row.admin ? <Chip>{t("manage.adminOnly")}</Chip> : null}
              </span>
              <span className="block truncate text-[12px] text-hint">{row.value}</span>
            </span>
            {locked ? null : <span className="chev">›</span>}
          </button>
        );
      })}
      <div className="row">
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">{t("manage.reminders")}</span>
          <span className="block text-[12px] text-hint">{t("manage.remindersHint")}</span>
        </span>
        <button
          type="button"
          className="switch"
          aria-pressed={event.remindersEnabled}
          aria-label={t("manage.reminders")}
          disabled={pending}
          onClick={() => {
            haptic.select();
            onToggleReminders();
          }}
        >
          <span />
        </button>
      </div>
    </section>
  );
};

type DoorTab = "waiting" | "in" | "handout";

/** The start: the count at the door, the one way in, and the list to work through. */
const StartDoor = ({
  info,
  roster,
  ticketed,
  pending,
  busyUser,
  busyItem,
  onScan,
  onShowQr,
  onToggle,
  onHandover,
  onRoster,
  onEnd,
}: {
  info: EventSummaryData;
  roster: readonly AttendanceRow[];
  ticketed: boolean;
  pending: boolean;
  busyUser: number | null;
  busyItem: number | null;
  onScan: () => void;
  onShowQr: () => void;
  onToggle: (person: AttendanceRow) => void;
  onHandover: (itemId: number) => void;
  onRoster: () => void;
  onEnd: () => void;
}) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<DoorTab>("waiting");
  const [query, setQuery] = useState("");
  // Runners only: staff are on the full roster, and the headline counts leave them out too.
  const people = roster.filter((person) => !person.isStaff && (person.status === "registered" || person.status === "checked_in"));
  const waiting = people.filter((person) => person.status === "registered");
  const checkedIn = people.filter((person) => person.status === "checked_in");
  const owed = people.filter((person) => owedItems(person).length > 0);
  // Everyone who bought something stays on the hand-out tab, so a wrong tick can be undone.
  const buyers = people.filter((person) => person.purchaseItems.length > 0);
  const needle = query.trim().toLowerCase();
  const source = needle ? people : tab === "waiting" ? waiting : tab === "in" ? checkedIn : buyers;
  const shown = source.filter((person) => !needle || [fullName(person), person.username ?? "", person.phone ?? ""].join(" ").toLowerCase().includes(needle));
  const tabs: ReadonlyArray<{ id: DoorTab; label: string }> = [
    { id: "waiting", label: t("manage.waiting", { n: waiting.length }) },
    { id: "in", label: t("manage.checkedIn", { n: checkedIn.length }) },
    ...(ticketed ? [{ id: "handout" as const, label: t("manage.handout", { n: owed.length }) }] : []),
  ];

  return (
    <>
      <section className="stattile rise p-[18px]">
        <div className="mb-2.5 flex items-end justify-between">
          <div>
            <div className="eyebrow">{t("status.checked_in")}</div>
            <div className="display text-[44px] leading-[0.9]">
              {info.counts.checkedIn}
              <span className="text-[22px] opacity-80">/{info.counts.registered}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="eyebrow">{t("manage.noShows")}</div>
            <div className="num text-[18px]">{info.counts.noShows}</div>
          </div>
        </div>
        <div className="track">
          <div className="track-fill" style={{ width: `${info.counts.registered ? Math.min(100, (info.counts.checkedIn / info.counts.registered) * 100) : 0}%` }} />
        </div>
      </section>
      {ticketed ? (
        <>
          <Button block className="mt-3.5 min-h-14 text-[14px]" loading={pending} disabled={!canScan()} onClick={onScan}>
            {t("manage.scanTicket")}
          </Button>
          {canScan() ? null : <p className="mx-1 mt-2.5 text-[12px]" style={{ color: "var(--ink-deep)" }}>{t("checkin.unavailable")}</p>}
        </>
      ) : (
        <>
          <Button block className="mt-3.5 min-h-14 text-[14px]" onClick={onShowQr}>
            {t("organizer.showQr")}
          </Button>
          <p className="mx-1 mt-2.5 text-[12px]" style={{ color: "var(--ink-deep)" }}>
            {t("manage.qrHint")}
          </p>
        </>
      )}

      <SearchInput className="mt-[18px]" placeholder={t("manage.findRunner")} aria-label={t("manage.findRunner")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {needle ? null : (
        <div className="seg mt-3" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className="tab"
              data-active={tab === item.id}
              onClick={() => {
                haptic.select();
                setTab(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <section className="card mt-3">
        {shown.length === 0 ? (
          <p className="px-4 py-5 text-center text-[13px] text-hint">{needle ? t("common.nothing") : t("manage.listEmpty")}</p>
        ) : (
          shown.map((person) => (
            <RosterRow
              key={person.userId}
              person={person}
              pending={busyUser === person.userId}
              onToggle={() => onToggle(person)}
              extra={
                tab === "handout" && !needle ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {person.purchaseItems.map((item) => (
                      <HandoverChip key={item.id} item={item} pending={busyItem === item.id} onToggle={() => onHandover(item.id)} />
                    ))}
                  </div>
                ) : undefined
              }
            />
          ))
        )}
      </section>
      <section className="card mt-2.5">
        <LinkRow label={t("manage.allRunners")} onPress={onRoster} />
      </section>
      <Button variant="ghost" block className="mt-4" loading={pending} onClick={onEnd}>
        {t("organizer.endEvent")}
      </Button>
    </>
  );
};

const WrapUp = ({ info }: { info: EventSummaryData }) => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const next = info.nextInSeries;
  const owed = info.merchOutstanding;
  return (
    <>
      <Rule label={t("manage.howItWent")} />
      <div className="grid grid-cols-3 gap-2">
        <Tile label={t("manage.came")} value={String(info.counts.checkedIn)} />
        <Tile label={t("manage.turnout")} value={info.counts.turnout === null ? "—" : percent(info.counts.turnout)} />
        <Tile label={t("manage.firstTime")} value={String(info.newcomers.came)} />
      </div>

      {info.money ? (
        <>
          <Rule label={t("manage.money")} />
          <section className="card">
            <Fact
              title={t("manage.revenue")}
              hint={[t("manage.ticketsSold", { n: info.money.ticketsSold }), ...info.money.itemsSold.map((item) => `${item.quantity} × ${item.name}`)].join(" · ")}
              value={money(info.money.revenueMinor, locale)}
            />
            <Fact
              title={t("manage.refunds")}
              hint={[
                info.money.refunds.count ? t("manage.refundsDone", { amount: money(info.money.refunds.amountMinor, locale) }) : t("manage.noRefunds"),
                info.money.refunds.pending ? t("manage.refundsPending", { n: info.money.refunds.pending }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              value={String(info.money.refunds.count)}
            />
            {owed.lines.length ? (
              <Fact
                title={t("manage.merchLeft")}
                hint={`${owed.lines.map((line) => `${line.name}${line.variantName ? ` · ${line.variantName}` : ""} ×${line.quantity}`).join(", ")} — ${t("manage.merchLeftHint")}`}
                value={String(owed.lines.reduce((sum, line) => sum + line.quantity, 0))}
              />
            ) : null}
          </section>
        </>
      ) : null}

      <Rule label={t("manage.after")} />
      <section className="card">
        {info.newcomers.registered > 0 ? (
          <Fact
            title={t(info.newcomers.removedFromChat ? "manage.newcomersRemoved" : "manage.newcomersMissed")}
            hint={t("manage.newcomersLine", { n: info.newcomers.missed, total: info.newcomers.registered })}
            value={String(info.newcomers.removedFromChat || info.newcomers.missed)}
          />
        ) : null}
        {next?.eventId ? (
          <button type="button" className="row" onClick={() => next.eventId && navigate(`/hq/events/${next.eventId}`)}>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">{t("manage.nextInSeries")}</span>
              <span className="block text-[12px] text-hint">{next.startsAt ? `${shortDate(next.startsAt, locale)} · ${timeOf(next.startsAt, locale)}` : "—"}</span>
            </span>
            <span className="chev">›</span>
          </button>
        ) : (
          <Fact
            title={t("manage.nextInSeries")}
            hint={
              next === null
                ? t("manage.notInSeries")
                : next.startsAt && next.draftAt
                  ? t("manage.nextDraftOn", { date: shortDate(next.startsAt, locale), draft: shortDate(next.draftAt, locale) })
                  : next.active
                    ? t("series.nextNone")
                    : t("series.paused")
            }
            value=""
          />
        )}
      </section>
    </>
  );
};

const Tile = ({ label, value }: { label: string; value: string }) => (
  <div className="stattile px-3.5 py-3">
    <div className="eyebrow mb-1">{label}</div>
    <div className="display text-[24px]">{value}</div>
  </div>
);

const Fact = ({ title, hint, value }: { title: string; hint: string; value: string }) => (
  <div className="row block">
    <div className="flex items-baseline gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">{title}</div>
        {hint ? <div className="text-[12px] text-hint">{hint}</div> : null}
      </div>
      <span className="num text-[13px]">{value}</span>
    </div>
  </div>
);

const SpotsSheet = ({
  capacity,
  waitlistEnabled,
  waiting,
  pending,
  onClose,
  onSave,
}: {
  capacity: number | null;
  waitlistEnabled: boolean;
  waiting: number;
  pending: boolean;
  onClose: () => void;
  onSave: (body: Partial<EventDraft>) => void;
}) => {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [spots, setSpots] = useState(capacity === null ? "" : String(capacity));
  const [queue, setQueue] = useState(waitlistEnabled);
  const save = async () => {
    // Turning the queue off drops everyone in it, so it is asked about first.
    if (waitlistEnabled && !queue) {
      const text = waiting > 0 ? t("admin.confirmDisableQueueWaiting", { n: waiting }) : t("admin.confirmDisableQueue");
      if (!(await confirm({ text, confirmLabel: t("admin.disableQueue"), danger: true }))) return;
    }
    onSave({ capacity: spots === "" ? null : Number(spots), waitlistEnabled: queue });
  };
  return (
    <Sheet title={t("manage.spots")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label={t("manage.totalSpots")} hint={t("manage.totalSpotsHint")}>
          <TextInput inputMode="numeric" placeholder="∞" value={spots} onChange={(event) => setSpots(event.target.value.replace(/\D/g, ""))} />
        </Field>
        <div className="card row">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">{t("manage.waitlist")}</span>
            <span className="block text-[12px] text-hint">{t("manage.waitlistHint")}</span>
          </span>
          <button type="button" className="switch" aria-pressed={queue} aria-label={t("manage.waitlist")} onClick={() => setQueue((value) => !value)}>
            <span />
          </button>
        </div>
        <SheetFooter>
          <Button block loading={pending} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </SheetFooter>
      </div>
    </Sheet>
  );
};
