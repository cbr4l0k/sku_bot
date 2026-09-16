import { useState } from "react";
import { Link } from "react-router";

import { sku } from "../api";
import { useI18n } from "../i18n";
import { bib, errorText, isPast } from "../lib/format";
import { useResource } from "../lib/useResource";
import { useSession } from "../session";
import { DateBlock, EventStatusChip } from "../ui/event";
import { Chip, EmptyState, ErrorState, Loader, PageTitle, Screen } from "../ui/primitives";
import { SeriesList } from "./Series";

type Tab = "events" | "series";

const EventsTab = () => {
  const { t } = useI18n();
  const events = useResource(sku.organizerEvents);

  return (
    <>
      {events.loading && !events.data ? <Loader label={t("common.loading")} /> : null}
      {events.error && !events.data ? (
        <ErrorState
          message={errorText(t, events.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void events.reload()}
        />
      ) : null}
      {events.data && events.data.length === 0 ? <EmptyState text={t("organizer.empty")} /> : null}

      <div className="flex flex-col gap-3">
        {(events.data ?? []).map((event, index) => (
          <Link
            key={event.id}
            to={`/organizer/events/${event.id}`}
            style={{ "--i": index } as React.CSSProperties}
            className={`card rise flex gap-3.5 px-4 py-4 active:scale-[0.985] ${event.endedAt ? "opacity-65" : ""}`}
          >
            <DateBlock iso={event.startsAt} />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-start justify-between gap-2">
                <h3 className="display min-w-0 text-[16px] leading-tight break-words">{event.title}</h3>
                <span className="num shrink-0 text-[10px] tracking-[0.2em] text-hint opacity-60">{bib(event.id)}</span>
              </div>
              <p className="mb-2.5 truncate text-[13px] text-hint">{event.location}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {event.endedAt ? <Chip>{t("organizer.ended")}</Chip> : <EventStatusChip status={event.status} />}
                {/* Started, and still waiting for someone to end it — the one state
                    an organizer needs to spot from the list. */}
                {!event.endedAt && isPast(event.startsAt) ? <Chip tone="flare">{t("organizer.live")}</Chip> : null}
                {/* A run raised from a template says so, so a draft that appeared
                    on its own is never mistaken for one somebody forgot about. */}
                {event.seriesId === null ? null : <Chip tone="soft">{t("series.inSeries")}</Chip>}
                <span className="num text-[10px] tracking-[0.12em] text-hint uppercase">
                  {event.capacity === null ? t("events.freeEntry") : `${t("detail.spots")} ${event.capacity}`}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
};

export const OrganizerScreen = () => {
  const { t } = useI18n();
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>("events");
  // Anyone who reaches this screen may look. The list itself is the authority —
  // it returns a branch admin's own branches and, for everyone else, only the
  // series they are actually named on — so gating the tab on a role as well
  // would hide a template from the very organizer who runs it every week.
  // Raising a new series stays a branch-admin power, enforced inside the list.
  const canSeeSeries = Boolean(me);

  return (
    <Screen>
      <PageTitle title={t("organizer.title")} />

      {canSeeSeries ? (
        <div className="mb-5 flex gap-1.5 rounded-full border border-hair p-1">
          {(["events", "series"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              data-active={tab === item}
              className="tab min-w-0 flex-1 flex-row justify-center py-2"
            >
              <span className="max-w-full truncate">
                {t(item === "events" ? "admin.tabEvents" : "series.title")}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {tab === "events" || !canSeeSeries ? <EventsTab /> : <SeriesList />}
    </Screen>
  );
};
