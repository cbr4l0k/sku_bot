import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

import { sku, type AttendanceRow, type EventDraft } from "../api";
import { useI18n } from "../i18n";
import { bib, countdown, errorText, fullDate, fullName } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource, useTicker } from "../lib/useResource";
import { haptic } from "../telegram";
import { CountdownRing, EventStatusChip } from "../ui/event";
import { EventForm } from "../ui/eventForm";
import { Sheet, useOverlayLock, useToast } from "../ui/overlays";
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

/* ------------------------------------------------------------ attendance row */

const PersonRow = ({
  person,
  index,
  pending,
  onToggle,
}: {
  person: AttendanceRow;
  index: number;
  pending: boolean;
  onToggle: () => void;
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
          {person.username ? <span className="break-all">@{person.username}</span> : null}
          {person.phone ? <span className="break-all">{person.phone}</span> : null}
          {person.status === "waitlisted" ? <Chip>{t("status.waitlisted")}</Chip> : null}
          {person.status === "canceled" ? <Chip>{t("status.canceled")}</Chip> : null}
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
  const action = useAction();
  useBackButton("/organizer");

  const id = Number(params.id);
  const [query, setQuery] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busyUser, setBusyUser] = useState<number | null>(null);

  const events = useResource(sku.organizerEvents);
  const attendance = useResource(useCallback(() => sku.attendance(id), [id]), { pollMs: 15_000 });

  const event = (events.data ?? []).find((item) => item.id === id) ?? null;
  const counts = attendance.data?.counts ?? null;

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
        aside={event ? <EventStatusChip status={event.status} /> : null}
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
        </div>
      </section>

      <div className="mb-4 flex gap-2">
        <Button block onClick={() => setShowQr(true)}>
          {t("organizer.showQr")}
        </Button>
        <Button variant="ghost" onClick={() => setEditing(true)}>
          {t("common.edit")}
        </Button>
      </div>

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
              onToggle={() => toggle(person)}
            />
          ))
        )}
      </section>

      {showQr ? <QrStage eventId={id} onClose={() => setShowQr(false)} /> : null}

      {editing ? (
        <Sheet title={t("organizer.edit")} onClose={() => setEditing(false)}>
          <EventForm
            initial={
              event
                ? {
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
    </Screen>
  );
};
