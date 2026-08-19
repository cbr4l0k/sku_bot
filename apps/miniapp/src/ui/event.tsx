import { Link } from "react-router";

import { CITIES } from "@sku/cities";

import type { EventCard as EventCardData, EventStatus, RegistrationStatus } from "../api";
import { useI18n } from "../i18n";
import { dayNumber, monthNumber, relativeDayKey, timeOf, weekdayShort } from "../lib/format";
import { useSession } from "../session";
import { GroupChips } from "./groups";
import { Chip, Track } from "./primitives";

export const StatusBadge = ({
  status,
  position,
  hasOffer,
}: {
  status: RegistrationStatus | null;
  position?: number | null;
  hasOffer?: boolean;
}) => {
  const { t } = useI18n();
  if (hasOffer) return <Chip tone="flare">{t("status.offer")}</Chip>;
  if (status === null || status === "canceled") return null;
  if (status === "waitlisted") {
    return <Chip tone="soft">{position ? t("status.waitlistedPos", { n: position }) : t("status.waitlisted")}</Chip>;
  }
  if (status === "checked_in") return <Chip tone="flare">{t("status.checked_in")}</Chip>;
  return <Chip tone="soft">{t("status.registered")}</Chip>;
};

export const EventStatusChip = ({ status }: { status: EventStatus }) => {
  const { t } = useI18n();
  const key = `eventStatus.${status}` as const;
  return (
    <Chip tone={status === "published" ? "soft" : "plain"} className={status === "canceled" ? "opacity-70" : ""}>
      {t(key)}
    </Chip>
  );
};

/**
 * The poster, shrunk to a tile: a panel of untouched brand teal carrying the
 * day stacked over the month in enormous tight-leaded white numerals, with the
 * time and weekday under them in the deep ink the teal can hold at small sizes.
 * The date is the star of every card, not a caption on it.
 */
export const DateBlock = ({ iso }: { iso: string }) => {
  const { locale, t } = useI18n();
  const relative = relativeDayKey(iso);
  return (
    <div className="datetile">
      <span className="datenum">{dayNumber(iso, locale)}</span>
      <span className="datenum">{monthNumber(iso, locale)}</span>
      <span className="num datetile-time">{timeOf(iso, locale)}</span>
      <span className="num datetile-day">{relative ? t(relative).toUpperCase() : weekdayShort(iso, locale)}</span>
    </div>
  );
};

export const EventCard = ({ event, index }: { event: EventCardData; index: number }) => {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const mine = event.myRegistrationStatus !== null && event.myRegistrationStatus !== "canceled";
  // A run only names its branch when it is not the one you are browsing — which
  // happens when you followed a link from elsewhere, or kept a spot after moving.
  const elsewhere = me?.city && event.city !== me.city ? CITIES[event.city] : null;
  const left = event.capacity === null ? null : Math.max(0, event.capacity - event.confirmedCount);

  return (
    <Link
      to={`/events/${event.id}`}
      style={{ "--i": index } as React.CSSProperties}
      className={`card rise block px-4 py-4 transition-[transform,box-shadow] duration-150 active:scale-[0.985] ${
        mine ? "card-mine pl-5" : ""
      }`}
    >
      <div className="flex gap-3.5">
        <DateBlock iso={event.startsAt} />
        <div className="min-w-0 flex-1">
          <h3 className="display mb-1 text-[16px] leading-[1.15] break-words">{event.title}</h3>
          <p className="mb-3 truncate text-[13px] text-hint">{event.location}</p>
          <Track
            value={event.confirmedCount}
            max={event.capacity}
            label={
              event.capacity === null
                ? t("events.freeEntry")
                : left === 0
                  ? t("events.full")
                  : t("events.spotsLeft", { n: left ?? 0 })
            }
            right={event.capacity === null ? `${event.confirmedCount}` : `${event.confirmedCount}/${event.capacity}`}
          />
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={event.myRegistrationStatus} hasOffer={event.myPendingOffer !== null} />
            {elsewhere ? (
              <span className="chip" style={{ background: elsewhere.brand, color: elsewhere.fieldInk === "light" ? "#ffffff" : "var(--ink-deep)" }}>
                {elsewhere.name[locale]}
              </span>
            ) : null}
            <GroupChips groups={event.groups} />
            {event.waitlistSize > 0 && !mine ? (
              <span className="num text-[10px] tracking-[0.12em] text-hint uppercase">
                {t("events.waitlistSize", { n: event.waitlistSize })}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </Link>
  );
};

/** Countdown ring: sweeps from full to empty over `total` ms. */
export const CountdownRing = ({
  remaining,
  total,
  size = 44,
  children,
}: {
  remaining: number;
  total: number;
  size?: number;
  children?: React.ReactNode;
}) => {
  const radius = size / 2 - 3;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--hair)" strokeWidth="3" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--flare)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          style={{ transition: "stroke-dashoffset 0.9s linear" }}
        />
      </svg>
      {children ? <div className="absolute inset-0 grid place-items-center">{children}</div> : null}
    </div>
  );
};
