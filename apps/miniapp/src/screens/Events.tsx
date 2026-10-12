import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router";

import { sku, type EventCard as EventCardData } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { errorText, relativeDayKey, shortDate, timeOf, untilStart, weekStart } from "../lib/format";
import { useResource, useTicker } from "../lib/useResource";
import { haptic } from "../telegram";
import { admission, EventCard, spotsLeft } from "../ui/event";
import { QrStage } from "../ui/roster";
import { useCheckinScan, useTicketScan, useTurnIn } from "./Checkin";
import { Button, EmptyState, ErrorState, Loader, PageTitle, Screen, SectionRule } from "../ui/primitives";

type Filter = "all" | "open" | "free";

const FILTERS: ReadonlyArray<{ value: Filter; key: MessageKey }> = [
  { value: "all", key: "events.filter.all" },
  { value: "open", key: "events.filter.open" },
  { value: "free", key: "events.filter.free" },
];

const holdsSpot = (event: EventCardData) =>
  event.myRegistrationStatus === "registered" || event.myRegistrationStatus === "checked_in";

/** Anything with a price on it puts the ticket in the runner's hands. Mirrors isPaidEvent on the server. */
export const isTicketed = (event: Pick<EventCardData, "ticketTiers" | "products">) =>
  event.ticketTiers.length > 0 || event.products.length > 0;

const spotsOpen = (event: EventCardData) => spotsLeft(event, event.confirmedCount) !== 0;

const WEEK = 7 * 86_400_000;

export const EventsScreen = () => {
  const { t } = useI18n();
  const events = useResource(sku.events, { pollMs: 45_000 });
  const [filter, setFilter] = useState<Filter>("all");

  const list = events.data ?? [];
  const next = list.find(holdsSpot) ?? null;
  const rest = list
    .filter((event) => event.id !== next?.id)
    .filter((event) => (filter === "open" ? spotsOpen(event) : filter === "free" ? admission(event).kind === "free" : true));

  // Runs group by calendar week, Monday first, the way a club plans them.
  const thisWeek = weekStart(new Date());
  const groups = new Map<MessageKey, EventCardData[]>();
  for (const event of rest) {
    const offset = Math.round((weekStart(new Date(event.startsAt)) - thisWeek) / WEEK);
    const key: MessageKey = offset <= 0 ? "events.week.this" : offset === 1 ? "events.week.next" : "events.week.later";
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  return (
    <Screen>
      <PageTitle title={t("events.title")} />

      {events.loading && !events.data ? <Loader label={t("common.loading")} /> : null}

      {events.error && !events.data ? (
        <ErrorState message={errorText(t, events.error)} retryLabel={t("common.retry")} onRetry={() => void events.reload()} />
      ) : null}

      {events.data && list.length === 0 ? <EmptyState text={t("events.empty")} /> : null}

      {/* Keyed so a scan or QR left open on one run never carries over to the next. */}
      {next ? <NextRun key={next.id} event={next} onChange={() => events.reload(true)} /> : null}

      {list.length > (next ? 1 : 0) ? (
        <div className="mt-[22px] flex gap-1.5" role="group" aria-label={t("events.filter.label")}>
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              className={`chip px-3 py-[7px] ${filter === option.value ? "chip-flare" : ""}`}
              onClick={() => {
                haptic.select();
                setFilter(option.value);
              }}
            >
              {t(option.key)}
            </button>
          ))}
        </div>
      ) : null}

      {[...groups].map(([key, items]) => (
        <section key={key}>
          <SectionRule label={t(key)} />
          <div className="flex flex-col gap-3">
            {items.map((event, index) => (
              <EventCard key={event.id} event={event} index={index} />
            ))}
          </div>
        </section>
      ))}

      {events.data && rest.length === 0 && list.length > (next ? 1 : 0) ? <EmptyState text={t("events.filter.empty")} /> : null}
    </Screen>
  );
};

/**
 * "Your next run": the countdown and one button, so the thing a runner opens the
 * app for on race morning is the first thing on it.
 */
const NextRun = ({ event, onChange }: { event: EventCardData; onChange: () => Promise<void> }) => {
  const { t, locale } = useI18n();
  const checkin = useCheckinScan(onChange);
  const turnIn = useTurnIn(event.id, onChange);
  const door = useTicketScan(event.id, onChange);
  const [showQr, setShowQr] = useState(false);
  const navigate = useNavigate();
  const now = useTicker(30_000);
  const ticketed = isTicketed(event);
  const checkedIn = event.myRegistrationStatus === "checked_in";
  // Staff are the ones holding the QR up, never the ones scanning it.
  const staff = event.myStaffEntry;
  const ticket = useResource(useCallback(() => sku.myTicket(event.id), [event.id]), { enabled: ticketed && !staff, pollMs: 60_000 });
  const toCollect = (ticket.data?.items ?? []).filter((item) => item.handedOverAt === null).length;
  const relative = relativeDayKey(event.startsAt);
  const when = `${relative ? t(relative) : shortDate(event.startsAt, locale)}, ${timeOf(event.startsAt, locale)}`;
  const msLeft = new Date(event.startsAt).getTime() - now;

  return (
    <article className="card rise p-[18px]">
      <div className="eyebrow mb-3">{t("events.next")}</div>
      <Link to={`/events/${event.id}`} className="block">
        <h2 className="display mb-1.5 text-[22px] leading-[1.05] break-words">{event.title}</h2>
        <p className="mb-4 text-[13px] text-hint">
          {when} · {event.location}
        </p>
      </Link>
      <dl className="mb-4 grid grid-cols-3 gap-2">
        <Figure label={t("events.untilStart")} value={msLeft > 0 ? untilStart(msLeft, (n) => t("events.days", { n })) : t("events.live")} />
        <Figure
          label={t("events.roster")}
          value={event.capacity === null ? `${event.confirmedCount}` : `${event.confirmedCount}/${event.capacity}`}
        />
        {ticketed ? (
          <Figure label={t("events.toCollect")} value={ticket.data ? String(toCollect) : "—"} />
        ) : (
          <Figure label={t("events.entry")} value="QR" />
        )}
      </dl>
      {staff ? (
        <>
          {!checkedIn ? (
            <Button block loading={turnIn.pending} onClick={turnIn.turnIn}>
              {t("action.turnIn")}
            </Button>
          ) : ticketed ? (
            <Button block loading={door.pending} onClick={door.scan}>
              {t("organizer.scanTickets")}
            </Button>
          ) : (
            <Button block onClick={() => setShowQr(true)}>
              {t("organizer.showQr")}
            </Button>
          )}
          <p className="mt-2.5 text-center text-[12px] text-hint">
            {t(!checkedIn ? (ticketed ? "events.turnInTicketsHint" : "events.turnInHint") : ticketed ? "events.scanTicketsHint" : "events.showQrHint")}
          </p>
        </>
      ) : ticketed ? (
        <>
          <Button block onClick={() => navigate(`/events/${event.id}/ticket`)}>
            {t("action.showTicket")}
          </Button>
          <p className="mt-2.5 text-center text-[12px] text-hint">{t("events.ticketHint")}</p>
        </>
      ) : checkedIn ? (
        <p className="text-center text-[13px] text-hint">{t("detail.checkedInHint")}</p>
      ) : (
        <>
          <Button block loading={checkin.pending} onClick={checkin.scan}>
            {t("action.scan")}
          </Button>
          <p className="mt-2.5 text-center text-[12px] text-hint">{t("events.scanHint")}</p>
        </>
      )}
      {showQr ? <QrStage eventId={event.id} onClose={() => setShowQr(false)} /> : null}
      {door.dialog}
    </article>
  );
};

const Figure = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="eyebrow text-[9px]">{label}</dt>
    <dd className="num text-[20px]">{value}</dd>
  </div>
);
