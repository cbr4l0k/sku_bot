import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";

import { sku, type SeriesDraft } from "../api";
import { useI18n } from "../i18n";
import { bib, errorText, percent } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { DateBlock, EventStatusChip } from "../ui/event";
import { Sheet, useConfirm, useToast } from "../ui/overlays";
import {
  Button,
  Chip,
  ErrorState,
  Loader,
  MiniBar,
  PageTitle,
  Screen,
  SectionRule,
  StatTile,
} from "../ui/primitives";
import { SeriesForm } from "../ui/seriesForm";
import { NextRunPanel } from "../ui/seriesNext";
import { MixTrend, TurnoutTrend } from "../ui/seriesTrend";

/** One raised run, as a row. Links into the organizer screen it already has. */
const OccurrenceRow = ({
  event,
  index,
}: {
  event: { id: number; title: string; startsAt: string; status: "draft" | "published" | "closed" | "canceled"; endedAt: string | null; capacity: number | null };
  index: number;
}) => {
  const { t } = useI18n();
  return (
    <Link
      to={`/organizer/events/${event.id}`}
      style={{ "--i": index } as React.CSSProperties}
      className={`card rise flex gap-3.5 px-4 py-3.5 active:scale-[0.985] ${event.endedAt ? "opacity-65" : ""}`}
    >
      <DateBlock iso={event.startsAt} />
      <div className="min-w-0 flex-1 self-center">
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <h3 className="display min-w-0 text-[15px] leading-tight break-words">{event.title}</h3>
          <span className="num shrink-0 text-[10px] tracking-[0.2em] text-hint opacity-60">{bib(event.id)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {event.endedAt ? <Chip>{t("organizer.ended")}</Chip> : <EventStatusChip status={event.status} />}
          <span className="num text-[10px] tracking-[0.12em] text-hint uppercase">
            {event.capacity === null ? t("events.freeEntry") : `${t("detail.spots")} ${event.capacity}`}
          </span>
        </div>
      </div>
    </Link>
  );
};

export const SeriesDetailScreen = () => {
  const { t } = useI18n();
  const { id } = useParams();
  const seriesId = Number(id);
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  const [editing, setEditing] = useState(false);

  const detail = useResource(useCallback(() => sku.seriesDetail(seriesId), [seriesId]));
  const stats = useResource(useCallback(() => sku.seriesStats(seriesId), [seriesId]));
  const catalog = useResource(
    useCallback(
      () => (detail.data ? sku.groupCatalog(detail.data.city) : Promise.resolve({ groups: [] })),
      [detail.data],
    ),
  );

  const refresh = async () => {
    await Promise.all([detail.reload(true), stats.reload(true)]);
  };

  const run = (task: () => Promise<unknown>, done: string) =>
    void action.run(
      async () => {
        await task();
        toast(done);
        await refresh();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  if (detail.loading && !detail.data) return <Screen><Loader label={t("common.loading")} /></Screen>;
  if (!detail.data) {
    return (
      <Screen>
        <ErrorState
          message={errorText(t, detail.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void detail.reload()}
        />
      </Screen>
    );
  }

  const series = detail.data;
  const numbers = stats.data;
  const tiers = series.ticketTiers.length;
  const products = series.products.length;

  const save = (draft: SeriesDraft) =>
    void action.run(
      async () => {
        await sku.updateSeries(seriesId, draft);
        toast(t("toast.seriesSaved"));
        setEditing(false);
        await refresh();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  return (
    <Screen>
      <PageTitle
        title={series.title}
        aside={
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {t("common.edit")}
          </Button>
        }
      />
      <p className="-mt-3 mb-5 truncate text-[13px] text-hint">{series.location}</p>

      <NextRunPanel
        nextStartsAt={series.nextStartsAt}
        cadenceDays={series.cadenceDays}
        leadDays={series.leadDays}
        busy={action.pending}
        onMove={(iso) => run(() => sku.updateSeries(seriesId, { nextStartsAt: iso }), t("toast.seriesSaved"))}
        onSpawn={() => run(() => sku.spawnOccurrence(seriesId), t("toast.occurrenceCreated"))}
        onSkip={() => {
          void (async () => {
            const ok = await confirm({
              text: t("series.confirmSkip", { n: series.cadenceDays ?? 0 }),
              confirmLabel: t("series.skip"),
            });
            if (ok) run(() => sku.skipOccurrence(seriesId), t("toast.skipped"));
          })();
        }}
      />

      {/* ---------------------------------------------------------- analytics */}
      {numbers && numbers.totals.occurrences > 0 ? (
        <>
          <SectionRule label={t("series.stats")} />
          <div className="grid grid-cols-2 gap-2.5">
            <StatTile label={t("series.statRuns")} value={String(numbers.totals.occurrences)} />
            <StatTile label={t("series.statPeople")} value={String(numbers.totals.uniqueParticipants)} />
          </div>
          <section className="card mt-2.5 px-4 py-4">
            <MiniBar
              label={t("series.statAttendance")}
              value={percent(numbers.totals.avgAttendanceRate)}
              ratio={numbers.totals.avgAttendanceRate}
            />
            <MiniBar
              label={t("series.statFill")}
              value={percent(numbers.totals.avgFillRate)}
              ratio={numbers.totals.avgFillRate}
            />
          </section>

          <SectionRule label={t("series.trend")} />
          <section className="card px-4 py-4">
            <TurnoutTrend occurrences={numbers.occurrences} />
          </section>

          <SectionRule label={t("series.retention")} />
          <section className="card px-4 py-4">
            <MixTrend occurrences={numbers.occurrences} />
            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-hair pt-3.5">
              <Chip>{t("series.retentionOnce")} {numbers.retention.onceOnly}</Chip>
              <Chip>{t("series.retentionFew")} {numbers.retention.twoToThree}</Chip>
              <Chip tone="soft">{t("series.retentionMany")} {numbers.retention.fourPlus}</Chip>
            </div>
          </section>

          {numbers.regulars.length > 0 ? (
            <>
              <SectionRule label={t("series.regulars")} />
              <section className="card divide-y divide-hair px-4">
                {numbers.regulars.map((person) => (
                  <div key={person.userId} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0 truncate text-[14px]">{person.firstName}</span>
                    <span className="num shrink-0 text-[12px] text-hint">
                      {t("series.attended", { n: person.attended, total: numbers.totals.occurrences })}
                    </span>
                  </div>
                ))}
              </section>
            </>
          ) : null}
        </>
      ) : null}

      {/* -------------------------------------------------------- occurrences */}
      {series.upcomingOccurrences.length > 0 ? (
        <>
          <SectionRule label={t("series.upcoming")} />
          <div className="flex flex-col gap-2.5">
            {series.upcomingOccurrences.map((event, index) => (
              <OccurrenceRow key={event.id} event={event} index={index} />
            ))}
          </div>
        </>
      ) : null}

      {series.pastOccurrences.length > 0 ? (
        <>
          <SectionRule label={t("series.past")} />
          <div className="flex flex-col gap-2.5">
            {[...series.pastOccurrences].reverse().map((event, index) => (
              <OccurrenceRow key={event.id} event={event} index={index} />
            ))}
          </div>
        </>
      ) : null}

      {/* ------------------------------------------------------------ template */}
      <SectionRule label={t("series.template")} />
      <section className="card px-4 py-4">
        <p className="mb-3 text-[12px] leading-snug text-hint">{t("series.templateHint")}</p>
        <div className="flex flex-wrap gap-1.5">
          {tiers === 0 && products === 0 ? (
            <Chip>{t("series.templateNothing")}</Chip>
          ) : (
            <>
              {tiers > 0 ? <Chip tone="soft">{t("series.templateTiers", { n: tiers })}</Chip> : null}
              {products > 0 ? <Chip tone="soft">{t("series.templateProducts", { n: products })}</Chip> : null}
            </>
          )}
        </div>
      </section>

      {editing ? (
        <Sheet title={t("common.edit")} onClose={() => setEditing(false)}>
          <SeriesForm
            initial={{
              city: series.city,
              title: series.title,
              description: series.description,
              location: series.location,
              locationUrl: series.locationUrl,
              capacity: series.capacity,
              nextStartsAt: series.nextStartsAt,
              cadenceDays: series.cadenceDays,
              leadDays: series.leadDays,
              groups: series.groups,
              homeChatId: series.homeChatId,
            }}
            submitLabel={t("common.save")}
            pending={action.pending}
            availableGroups={catalog.data?.groups ?? []}
            cities={[series.city]}
            onSubmit={save}
          />
        </Sheet>
      ) : null}
    </Screen>
  );
};
