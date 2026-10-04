import { useState } from "react";

import type { SeriesOccurrence } from "../api";
import { useI18n } from "../i18n";
import { dayMonth } from "../lib/format";

const RUNS = 8;
const PLOT = 120;

/**
 * How people show up, one column per held run: the column is the room there
 * was, the lighter fill who signed up, the deep fill who came. Columns share
 * one scale, so a bigger run stands taller — capacity is part of the story.
 */
export const ShowUpChart = ({ occurrences }: { occurrences: readonly SeriesOccurrence[] }) => {
  const { t, locale } = useI18n();
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const held = occurrences.filter((occurrence) => occurrence.held);
  const runs = all ? held : held.slice(-RUNS);
  if (runs.length === 0) return <p className="py-2 text-[13px] text-hint">{t("series.trendEmpty")}</p>;
  // The exact numbers sit under the chart, for the tapped run or else the latest.
  const focus = runs.find((run) => run.eventId === picked) ?? runs[runs.length - 1]!;

  const room = (run: SeriesOccurrence) => Math.max(run.capacity ?? 0, run.registered, run.checkedIn, 1);
  const ceiling = Math.max(...runs.map(room));

  return (
    <div>
      <div className="flex gap-1.5 overflow-x-auto" aria-label={t("series.trendLabel", { n: runs.length })}>
        {runs.map((run) => {
          const base = room(run);
          return (
            <button
              key={run.eventId}
              type="button"
              aria-pressed={run.eventId === focus.eventId}
              onClick={() => setPicked(run.eventId)}
              className="flex min-w-[22px] flex-1 flex-col items-center gap-1.5"
              style={{ opacity: run.eventId === focus.eventId ? 1 : 0.72 }}
            >
              <div className="flex w-full items-end" style={{ height: PLOT }}>
                <div className="relative w-full overflow-hidden rounded-md" style={{ height: (base / ceiling) * PLOT, background: "var(--veil)" }}>
                  <div className="absolute inset-x-0 bottom-0" style={{ height: `${(run.registered / base) * 100}%`, background: "var(--brand)" }} />
                  <div className="absolute inset-x-0 bottom-0" style={{ height: `${(run.checkedIn / base) * 100}%`, background: "var(--brand-deep)" }} />
                </div>
              </div>
              <span className="num text-[9px] text-hint">{dayMonth(run.startsAt, locale)}</span>
            </button>
          );
        })}
      </div>
      <p className="num mt-3 text-[12px]">
        {dayMonth(focus.startsAt, locale)} · {t("series.trendLegendCame")} {focus.checkedIn} · {t("series.trendLegendSigned")} {focus.registered}/
        {focus.capacity ?? "∞"} · {t("series.newcomers")} {focus.newcomers} · {t("series.returning")} {focus.returning}
      </p>
      {held.length > RUNS ? (
        <button type="button" className="mt-2 text-[12px] underline underline-offset-2" onClick={() => setAll((value) => !value)}>
          {all ? t("series.lastN", { n: RUNS }) : t("series.allRuns", { n: held.length })}
        </button>
      ) : null}
      <div className="mt-3.5 flex flex-wrap gap-3.5">
        <Legend color="var(--brand-deep)" label={t("series.trendLegendCame")} />
        <Legend color="var(--brand)" label={t("series.trendLegendSigned")} />
        <Legend color="var(--veil)" label={t("series.trendLegendRoom")} outline />
      </div>
    </div>
  );
};

const Legend = ({ color, label, outline = false }: { color: string; label: string; outline?: boolean }) => (
  <span className="inline-flex items-center gap-1.5 text-[12px]">
    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color, border: outline ? "1px solid var(--hair)" : undefined }} />
    {label}
  </span>
);
