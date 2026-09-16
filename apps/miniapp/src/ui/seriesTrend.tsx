import type { SeriesOccurrence } from "../api";
import { useI18n } from "../i18n";
import { dayNumber, monthNumber, weekdayShort } from "../lib/format";

/**
 * Turnout across a series, one row per run.
 *
 * A bullet, not a stacked bar. Three quantities sit on one line — capacity, who
 * signed up, who actually came — and only one of them is the point, so only one
 * of them is a filled mark: the accent bar is attendance, the tick is the
 * sign-up it is measured against, and the track behind both is the capacity.
 * Two saturated fills were tried first and rejected on measurement, not taste:
 * the two rungs of the brand this palette could spare read 12.2 ΔE apart, close
 * enough that a full-colour reader cannot reliably tell one segment from the
 * other, let alone a colourblind one.
 *
 * Every row is labelled outright. A phone has no hover to put the numbers in,
 * and a series is a handful of runs rather than a dense series, so the figures
 * simply sit beside their bar.
 */
export const TurnoutTrend = ({ occurrences }: { occurrences: readonly SeriesOccurrence[] }) => {
  const { t, locale } = useI18n();
  // A run nobody could attend yet says nothing about turnout, and averaging it
  // in would read as a collapse rather than as a date in the future.
  const held = occurrences.filter((occurrence) => occurrence.checkedIn > 0 || occurrence.registered > 0);
  if (held.length === 0) return <p className="px-1 py-2 text-[13px] text-hint">{t("series.trendEmpty")}</p>;

  // One scale for every row: bars across runs are only comparable if the widest
  // thing on any of them sets the width of all of them.
  const ceiling = Math.max(...held.map((o) => Math.max(o.capacity ?? 0, o.registered, o.checkedIn)), 1);

  return (
    <div>
      <div className="mb-3 flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-full" style={{ background: "var(--flare)" }} />
          <span className="num text-[10px] tracking-[0.14em] text-hint uppercase">{t("series.trendLegendCame")}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-0.5 rounded-full" style={{ background: "var(--ink-dim)" }} />
          <span className="num text-[10px] tracking-[0.14em] text-hint uppercase">{t("series.trendLegendSigned")}</span>
        </span>
        {/* The track is a third quantity and belongs in the legend: unnamed, the
            pale remainder behind the bar reads as a second data segment rather
            than as the room that was left. */}
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-full" style={{ background: "var(--veil)" }} />
          <span className="num text-[10px] tracking-[0.14em] text-hint uppercase">{t("series.trendLegendRoom")}</span>
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {held.map((occurrence, index) => {
          const came = Math.min(1, occurrence.checkedIn / ceiling);
          const signed = Math.min(1, occurrence.registered / ceiling);
          return (
            <div
              key={occurrence.eventId}
              className="rise flex items-center gap-3"
              style={{ "--i": index } as React.CSSProperties}
            >
              <span className="num w-[42px] shrink-0 text-[11px] leading-tight text-hint">
                {dayNumber(occurrence.startsAt, locale)}.{monthNumber(occurrence.startsAt, locale)}
                <span className="block text-[9px] tracking-[0.14em] opacity-70">
                  {weekdayShort(occurrence.startsAt, locale)}
                </span>
              </span>

              <div className="relative min-w-0 flex-1">
                <div className="track" style={{ height: 10 }}>
                  <div className="track-fill" style={{ width: `${Math.max(came * 100, occurrence.checkedIn > 0 ? 4 : 0)}%` }} />
                </div>
                {/* Where sign-ups reached, as a rule rather than a second fill.
                    Inset by its own width at the far end so a full house keeps
                    the tick on the bar instead of hanging off it. */}
                <span
                  aria-hidden
                  className="absolute top-1/2 h-[15px] w-0.5 -translate-y-1/2 rounded-full"
                  style={{ left: `calc(${signed * 100}% - ${signed >= 1 ? 2 : 1}px)`, background: "var(--ink-dim)" }}
                />
              </div>

              <span className="num w-[58px] shrink-0 text-right text-[11px] leading-tight">
                {occurrence.checkedIn}/{occurrence.registered}
                <span className="block text-[9px] text-hint opacity-80">
                  {occurrence.capacity === null ? "∞" : occurrence.capacity}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Newcomers against returners, per run. The pair is a true part-to-whole — they
 * sum to everyone who signed up — so here a split bar is honest, and the two
 * halves are told apart by weight and a surface gap rather than by a second hue.
 */
export const MixTrend = ({ occurrences }: { occurrences: readonly SeriesOccurrence[] }) => {
  const { t, locale } = useI18n();
  const held = occurrences.filter((occurrence) => occurrence.newcomers + occurrence.returning > 0);
  if (held.length === 0) return null;

  return (
    <div className="flex flex-col gap-2.5">
      {held.map((occurrence, index) => {
        const total = occurrence.newcomers + occurrence.returning;
        const share = occurrence.newcomers / total;
        return (
          <div
            key={occurrence.eventId}
            className="rise flex items-center gap-3"
            style={{ "--i": index } as React.CSSProperties}
          >
            <span className="num w-[42px] shrink-0 text-[11px] text-hint">
              {dayNumber(occurrence.startsAt, locale)}.{monthNumber(occurrence.startsAt, locale)}
            </span>
            <div className="flex min-w-0 flex-1 items-center" style={{ height: 10 }}>
              <span
                className="h-full rounded-full"
                style={{ width: `calc(${share * 100}% - 1px)`, background: "var(--flare)" }}
              />
              {/* The 2px surface gap that separates the halves — a gap, never a
                  border drawn around either one. */}
              <span className="h-full shrink-0" style={{ width: 2 }} />
              <span
                className="h-full rounded-full"
                style={{ width: `calc(${(1 - share) * 100}% - 1px)`, background: "var(--flare-soft)" }}
              />
            </div>
            <span className="num w-[58px] shrink-0 text-right text-[11px]">
              {occurrence.newcomers}
              <span className="text-hint">/{occurrence.returning}</span>
            </span>
          </div>
        );
      })}
      <div className="mt-1 flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-full" style={{ background: "var(--flare)" }} />
          <span className="num text-[10px] tracking-[0.14em] text-hint uppercase">{t("series.newcomers")}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-full" style={{ background: "var(--flare-soft)" }} />
          <span className="num text-[10px] tracking-[0.14em] text-hint uppercase">{t("series.returning")}</span>
        </span>
      </div>
    </div>
  );
};
