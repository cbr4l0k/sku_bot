import { useCallback, useState } from "react";
import { Link } from "react-router";

import { CITIES, type CitySlug } from "@sku/cities";

import { sku, type SeriesDraft, type SeriesSummary } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { dayMonth, errorText, percent, shortDate, timeOf, weekdayShort } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { useSession } from "../session";
import { Sheet, useToast } from "../ui/overlays";
import { Button, Chip, EmptyState, ErrorState, Loader } from "../ui/primitives";
import { SeriesForm } from "../ui/seriesForm";

export const SeriesList = () => {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { me } = useSession();
  const action = useAction();
  const series = useResource(sku.series);
  const [creating, setCreating] = useState(false);

  const myCities = me?.adminCities ?? [];
  const [formCity, setFormCity] = useState<CitySlug | null>(null);
  const activeCity = formCity ?? myCities[0] ?? null;
  const catalog = useResource(
    useCallback(() => (activeCity ? sku.groupCatalog(activeCity) : Promise.resolve({ groups: [] })), [activeCity]),
  );

  const create = (draft: SeriesDraft) =>
    void action.run(
      async () => {
        await sku.createSeries(draft);
        toast(t("toast.seriesCreated"));
        setCreating(false);
        await series.reload(true);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  return (
    <>
      {myCities.length > 0 ? (
        <Button variant="ghost" block className="mb-4" onClick={() => setCreating(true)}>
          + {t("series.create")}
        </Button>
      ) : null}

      {series.loading && !series.data ? <Loader label={t("common.loading")} /> : null}
      {series.error && !series.data ? (
        <ErrorState
          message={errorText(t, series.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void series.reload()}
        />
      ) : null}
      {series.data && series.data.length === 0 ? <EmptyState text={t("series.empty")} /> : null}

      <div className="flex flex-col gap-3">
        {(series.data ?? []).map((row, index) => (
          <SeriesCard key={row.id} row={row} index={index} showCity={myCities.length > 1} />
        ))}
      </div>

      {creating ? (
        <Sheet title={t("series.create")} onClose={() => setCreating(false)}>
          <SeriesForm
            submitLabel={t("form.create")}
            pending={action.pending}
            availableGroups={catalog.data?.groups ?? []}
            cities={myCities}
            onCityChange={setFormCity}
            onSubmit={create}
          />
        </Sheet>
      ) : null}
    </>
  );
};

const STATUS: Record<SeriesSummary["status"], MessageKey | null> = {
  draft_ready: "series.statusDraft",
  no_date: "series.statusNoDate",
  paused: "series.paused",
  scheduled: null,
};

const SeriesCard = ({ row, index, showCity }: { row: SeriesSummary; index: number; showCity: boolean }) => {
  const { t, locale } = useI18n();
  const status = STATUS[row.status];
  const rhythm = [
    row.cadenceDays === null ? t("series.byHand") : t("series.everyNDays", { n: row.cadenceDays }),
    row.nextUp ? `${weekdayShort(row.nextUp, locale)} ${timeOf(row.nextUp, locale)}` : null,
    row.location,
  ]
    .filter(Boolean)
    .join(" · ");
  const record = [
    t("series.heldCount", { n: row.held }),
    row.avgTurnout === null ? null : t("series.turnoutShort", { value: percent(row.avgTurnout) }),
    row.status === "paused" && row.pausedSince
      ? t("series.pausedSince", { date: dayMonth(row.pausedSince, locale) })
      : row.leaders.length
        ? t("series.ledBy", { names: row.leaders.join(", ") })
        : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Link to={`/series/${row.id}`} style={{ "--i": index } as React.CSSProperties} className="card rise block p-4 active:scale-[0.985]">
      <div className="mb-1 flex items-start justify-between gap-2.5">
        <h3 className="display min-w-0 text-[16px] leading-[1.15] break-words">{row.title}</h3>
        <span className="flex shrink-0 items-center gap-1.5">
          {showCity ? (
            <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: CITIES[row.city].brand }} />
          ) : null}
          {status ? <Chip tone={row.status === "draft_ready" ? "soft" : "plain"}>{t(status)}</Chip> : null}
        </span>
      </div>
      <p className="num mb-3 truncate text-[11px] tracking-[0.06em] text-hint">{rhythm}</p>
      <div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5" style={{ background: "var(--flare-soft)" }}>
        <span className="eyebrow text-[9px]">{t("series.next")}</span>
        <span className="flex-1 text-[13px] font-semibold">
          {row.status === "paused" ? "—" : row.nextUp ? `${shortDate(row.nextUp, locale)}, ${timeOf(row.nextUp, locale)}` : t("series.nextNone")}
        </span>
        <span className="chev">›</span>
      </div>
      <div className="num mt-2.5 text-[11px] text-hint">{record}</div>
    </Link>
  );
};
