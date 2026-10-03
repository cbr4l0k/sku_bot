import { useCallback, useEffect, useRef, useState } from "react";

import { sku, type AttendanceRow, type ScannedTicket } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { countdown, fullName, initials, timeOf } from "../lib/format";
import { useResource, useTicker } from "../lib/useResource";
import { haptic } from "../telegram";
import { CountdownRing } from "./event";
import { Dialog, Sheet, useOverlayLock } from "./overlays";
import { Button, Chip, EmptyState, Loader, SearchInput, TelegramUsername } from "./primitives";
import { QrCanvas } from "./qr";
import { Backdrop } from "./swoosh";

type PurchaseLine = AttendanceRow["purchaseItems"][number];

const METHOD: Record<NonNullable<AttendanceRow["checkinMethod"]>, MessageKey> = {
  qr: "manage.byQr",
  ticket: "manage.byTicket",
  manual: "manage.byHand",
};

/** Merch still owed to this person — what the door has to hand over. */
export const owedItems = (person: Pick<AttendanceRow, "purchaseItems">) => person.purchaseItems.filter((item) => item.handedOverAt === null);

/** The one line under a name that says what matters about this person at the door. */
const useDescribe = () => {
  const { t, locale } = useI18n();
  return (person: AttendanceRow): string => {
    if (person.status === "checked_in") {
      const when = person.checkedInAt ? timeOf(person.checkedInAt, locale) : null;
      return [when, person.checkinMethod ? t(METHOD[person.checkinMethod]) : null].filter(Boolean).join(" · ");
    }
    if (person.status === "waitlisted") return t("status.waitlisted");
    if (person.status === "canceled") return t("status.canceled");
    const owed = owedItems(person);
    if (owed.length) return t("manage.collects", { items: owed.map((item) => item.name).join(", ") });
    if (person.isStaff) return t("status.staff");
    if (person.firstTime) return t("manage.firstTime");
    if (person.fromWaitlist) return t("manage.fromWaitlist");
    return person.ticketName ?? "";
  };
};

/** A runner at the door: who they are, the one fact that matters, and the action. */
export const RosterRow = ({
  person,
  pending,
  onToggle,
  extra,
}: {
  person: AttendanceRow;
  pending: boolean;
  onToggle?: () => void;
  extra?: React.ReactNode;
}) => {
  const { t } = useI18n();
  const describe = useDescribe();
  const checked = person.status === "checked_in";
  const togglable = onToggle && (person.status === "registered" || checked);
  return (
    <div className="row items-start">
      <span className="av">{initials(person)}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold">{fullName(person)}</div>
        <div className="text-[12px] text-hint">{describe(person)}</div>
        {extra}
      </div>
      {togglable ? (
        checked ? (
          <button type="button" disabled={pending} onClick={onToggle} className="chip chip-flare self-center" aria-label={t("organizer.manualToggle")}>
            {t("status.checked_in")}
          </button>
        ) : (
          <Button size="sm" variant="ghost" className="self-center" loading={pending} onClick={onToggle}>
            {t("manage.checkIn")}
          </Button>
        )
      ) : null}
    </div>
  );
};

/** One merch line, tappable: the same act in the scan dialog and the roster. */
export const HandoverChip = ({ item, pending, onToggle }: { item: PurchaseLine; pending: boolean; onToggle: () => void }) => {
  const handed = item.handedOverAt !== null;
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={handed}
      onClick={onToggle}
      className={`chip ${handed ? "chip-flare" : "chip-soft"} active:scale-95 ${pending ? "opacity-50" : ""}`}
    >
      {handed ? "✓ " : ""}
      {item.name}
      {item.quantity > 1 ? ` ×${item.quantity}` : ""}
    </button>
  );
};

/** Everyone on the event, searchable, with every manual fix the door might need. */
export const RosterSheet = ({
  title,
  rows,
  busyUser,
  busyItem,
  onToggle,
  onHandover,
  onClose,
}: {
  title: string;
  rows: readonly AttendanceRow[];
  busyUser: number | null;
  busyItem: number | null;
  onToggle: (person: AttendanceRow) => void;
  onHandover: (itemId: number) => void;
  onClose: () => void;
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = rows.filter((person) => !needle || [fullName(person), person.username ?? "", person.phone ?? ""].join(" ").toLowerCase().includes(needle));
  return (
    <Sheet title={title} onClose={onClose} full>
      <SearchInput className="mb-3" placeholder={t("manage.findRunner")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {shown.length === 0 ? (
        <EmptyState text={needle ? t("common.nothing") : t("organizer.noRegistrations")} />
      ) : (
        <div className="card">
          {shown.map((person) => (
            <RosterRow
              key={person.userId}
              person={person}
              pending={busyUser === person.userId}
              onToggle={() => onToggle(person)}
              extra={
                <div className="num mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-hint">
                  {person.username ? <TelegramUsername username={person.username} /> : null}
                  {person.phone ? <span className="break-all">{person.phone}</span> : null}
                  {person.ticketName ? <Chip tone="soft">{person.ticketName}</Chip> : null}
                  {person.purchaseItems.map((item) => (
                    <HandoverChip key={item.id} item={item} pending={busyItem === item.id} onToggle={() => onHandover(item.id)} />
                  ))}
                  {person.paymentStatus && person.paymentStatus !== "fulfilled" ? <Chip>{person.paymentStatus}</Chip> : null}
                </div>
              }
            />
          ))}
        </div>
      )}
    </Sheet>
  );
};

const TOKEN_WINDOW_MS = 30_000;

/** The free-run door: a rotating code on the field, big enough to scan from a step away. */
export const QrStage = ({ eventId, onClose }: { eventId: number; onClose: () => void }) => {
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

/**
 * A ticket just scanned. It stays up after the check-in because the scan is only
 * half the job: the merch still has to change hands, and each line can only be
 * ticked off once.
 */
export const ScanDialog = ({
  scanned,
  position,
  pending,
  busyItem,
  onHandover,
  onNext,
  onClose,
}: {
  scanned: ScannedTicket;
  position: { n: number; total: number } | null;
  pending: boolean;
  busyItem: number | null;
  onHandover: (itemId: number) => void;
  onNext: () => void;
  onClose: () => void;
}) => {
  const { t, locale } = useI18n();
  const eyebrow = [scanned.number === null ? null : t("manage.ticketNo", { n: String(scanned.number).padStart(4, "0") }), scanned.ticketName]
    .filter(Boolean)
    .join(" · ");
  return (
    <Dialog eyebrow={eyebrow || undefined} title={fullName(scanned)} onClose={onClose}>
      <div className="mt-1 flex items-center justify-center gap-2">
        <Chip tone={scanned.alreadyCheckedIn ? "plain" : "soft"}>
          {scanned.alreadyCheckedIn ? t("organizer.alreadyCheckedIn") : `✓ ${t("status.checked_in")}`}
        </Chip>
        <span className="num text-[11px] text-hint">
          {[timeOf(scanned.checkedInAt, locale), position ? t("manage.position", { n: position.n, total: position.total }) : null].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="hairline mt-[18px] mb-4" />
      <div className="eyebrow mb-2">{t("organizer.handoverTitle")}</div>
      {scanned.items.length === 0 ? (
        <p className="mb-[18px] text-[13px] text-hint">{t("organizer.nothingToHandOver")}</p>
      ) : (
        <>
          <div className="card bg-white">
            {scanned.items.map((item) => (
              <div key={item.id} className="row">
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">{item.name}</span>
                  {item.quantity > 1 ? <span className="block text-[12px] text-hint">× {item.quantity}</span> : null}
                </span>
                <button
                  type="button"
                  className="switch"
                  aria-pressed={item.handedOverAt !== null}
                  aria-label={t("manage.handedOut", { item: item.name })}
                  disabled={busyItem === item.id}
                  onClick={() => {
                    haptic.select();
                    onHandover(item.id);
                  }}
                >
                  <span />
                </button>
              </div>
            ))}
          </div>
          <p className="mx-0.5 mt-2 mb-[18px] text-[12px] text-hint">{t("manage.handoutHint")}</p>
        </>
      )}
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
        <Button loading={pending} onClick={onNext}>
          {t("manage.nextRunner")}
        </Button>
      </div>
    </Dialog>
  );
};
