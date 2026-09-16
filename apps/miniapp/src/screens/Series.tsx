import { useCallback, useState } from "react";
import { Link } from "react-router";

import { CITIES, type CitySlug } from "@sku/cities";

import { sku, type SeriesDraft } from "../api";
import { useI18n } from "../i18n";
import { bib, errorText, timeOf, weekdayShort } from "../lib/format";
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
      <p className="mb-4 text-[13px] leading-snug text-hint">{t("series.subtitle")}</p>

      {myCities.length > 0 ? (
        <Button block className="mb-4" onClick={() => setCreating(true)}>
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
          <Link
            key={row.id}
            to={`/series/${row.id}`}
            style={{ "--i": index } as React.CSSProperties}
            className={`card rise block px-4 py-4 active:scale-[0.985] ${row.active ? "" : "opacity-65"}`}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <h3 className="display min-w-0 text-[16px] leading-tight break-words">{row.title}</h3>
              <span className="num shrink-0 text-[10px] tracking-[0.2em] text-hint opacity-60">{bib(row.id)}</span>
            </div>
            <p className="mb-2.5 truncate text-[13px] text-hint">{row.location}</p>

            <div className="flex flex-wrap items-center gap-1.5">
              {/* The next date is what a person came to this list to check, so it
                  is the one thing promoted to a filled chip. */}
              {row.nextStartsAt ? (
                <Chip tone="flare">
                  {new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", { day: "2-digit", month: "2-digit" })
                    .format(new Date(row.nextStartsAt))}
                  {" · "}
                  {weekdayShort(row.nextStartsAt, locale)} {timeOf(row.nextStartsAt, locale)}
                </Chip>
              ) : (
                <Chip tone="soft">{t("series.nextNone")}</Chip>
              )}
              {row.active ? null : <Chip>{t("series.paused")}</Chip>}
              <span className="num text-[10px] tracking-[0.12em] text-hint uppercase">
                {row.cadenceDays === null ? t("series.byHand") : t("series.everyNDays", { n: row.cadenceDays })}
              </span>
              {myCities.length > 1 ? (
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: CITIES[row.city].brandLift, boxShadow: `0 0 0 2px ${CITIES[row.city].brand}` }}
                />
              ) : null}
            </div>
          </Link>
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
