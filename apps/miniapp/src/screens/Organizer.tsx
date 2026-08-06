import { Link } from "react-router";

import { sku } from "../api";
import { useI18n } from "../i18n";
import { bib, errorText, isPast } from "../lib/format";
import { useResource } from "../lib/useResource";
import { DateBlock, EventStatusChip } from "../ui/event";
import { EmptyState, ErrorState, Loader, PageTitle, Screen } from "../ui/primitives";

export const OrganizerScreen = () => {
  const { t } = useI18n();
  const events = useResource(sku.organizerEvents);

  return (
    <Screen>
      <PageTitle eyebrow={t("organizer.subtitle")} title={t("organizer.title")} />

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
            className={`card rise flex gap-3.5 px-4 py-4 active:scale-[0.985] ${isPast(event.startsAt) ? "opacity-65" : ""}`}
          >
            <DateBlock iso={event.startsAt} />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-start justify-between gap-2">
                <h3 className="display text-[16px] leading-tight">{event.title}</h3>
                <span className="num text-[10px] tracking-[0.2em] text-hint opacity-60">{bib(event.id)}</span>
              </div>
              <p className="mb-2.5 truncate text-[13px] text-hint">{event.location}</p>
              <div className="flex items-center gap-1.5">
                <EventStatusChip status={event.status} />
                <span className="num text-[10px] tracking-[0.12em] text-hint uppercase">
                  {event.capacity === null ? t("events.freeEntry") : `${t("detail.spots")} ${event.capacity}`}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </Screen>
  );
};
