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
  const runs = occurrences.filter((occurrence) => occurrence.held).slice(-RUNS);
  if (runs.length === 0) return <p className="py-2 text-[13px] text-hint">{t("series.trendEmpty")}</p>;

  const room = (run: SeriesOccurrence) => Math.max(run.capacity ?? 0, run.registered, run.checkedIn, 1);
  const ceiling = Math.max(...runs.map(room));

  return (
    <div>
      <div className="flex gap-1.5" role="img" aria-label={t("series.trendLabel", { n: runs.length })}>
        {runs.map((run) => {
          const base = room(run);
          return (
            <div key={run.eventId} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <div className="flex w-full items-end" style={{ height: PLOT }}>
                <div className="relative w-full overflow-hidden rounded-md" style={{ height: (base / ceiling) * PLOT, background: "var(--veil)" }}>
                  <div className="absolute inset-x-0 bottom-0" style={{ height: `${(run.registered / base) * 100}%`, background: "var(--brand)" }} />
                  <div className="absolute inset-x-0 bottom-0" style={{ height: `${(run.checkedIn / base) * 100}%`, background: "var(--brand-deep)" }} />
                </div>
              </div>
              <span className="num text-[9px] text-hint">{dayMonth(run.startsAt, locale)}</span>
            </div>
          );
        })}
      </div>
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
