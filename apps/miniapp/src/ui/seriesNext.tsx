import { useState } from "react";

import { useI18n } from "../i18n";
import { fromLocalInput, toLocalInput, weekdayShort } from "../lib/format";
import { Sheet, SheetFooter } from "./overlays";
import { Button, Field, TextInput } from "./primitives";

/**
 * When the next run is, and the one control that moves it.
 *
 * The date is a value a person sets, never a rule the app derives — a series
 * here alternates Sunday morning and Wednesday evening, so anything that
 * computed the date from a cadence would spend its life being corrected. The
 * cadence is therefore demoted to a caption: it proposes the following date
 * after a run is raised, and nothing more. A series with no cadence at all is
 * not a broken series, so it is shown as a plain fact rather than a warning.
 */
export const NextRunPanel = ({
  nextStartsAt,
  cadenceDays,
  leadDays,
  busy = false,
  onMove,
  onSpawn,
  onSkip,
}: {
  nextStartsAt: string | null;
  cadenceDays: number | null;
  leadDays: number;
  busy?: boolean;
  onMove: (iso: string | null) => void;
  onSpawn: () => void;
  onSkip: () => void;
}) => {
  const { t, locale } = useI18n();
  const [moving, setMoving] = useState(false);
  const [draft, setDraft] = useState("");

  const open = () => {
    setDraft(nextStartsAt ? toLocalInput(nextStartsAt) : "");
    setMoving(true);
  };

  const date = nextStartsAt ? new Date(nextStartsAt) : null;
  const cadence = cadenceDays === null ? t("series.byHand") : t("series.everyNDays", { n: cadenceDays });

  return (
    <>
      {/* The poster move, at panel size: untouched brand teal carrying the date
          in white display type. A card would have made the next run look like
          one more row; it is the whole point of the screen. */}
      <section className="card overflow-hidden">
        <div className="px-4 py-4" style={{ background: "var(--brand)" }}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="eyebrow" style={{ color: "var(--ink-deep)" }}>
              {t("series.next")}
            </span>
            <span className="num text-[10px] tracking-[0.14em] uppercase" style={{ color: "var(--ink-deep)" }}>
              {cadence}
            </span>
          </div>

          {date ? (
            <>
              <div className="display text-[30px] leading-[0.95] text-white">
                {new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", {
                  day: "2-digit",
                  month: "long",
                }).format(date)}
              </div>
              <div className="num mt-1.5 text-[12px]" style={{ color: "var(--ink-deep)" }}>
                {weekdayShort(nextStartsAt as string, locale)} ·{" "}
                {new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                }).format(date)}
              </div>
            </>
          ) : (
            <div className="display text-[24px] leading-tight text-white">{t("series.nextNone")}</div>
          )}

          <p className="mt-2.5 text-[11px] leading-snug" style={{ color: "var(--ink-deep)" }}>
            {date ? t("series.nextHint", { n: leadDays }) : t("series.nextNoneHint", { n: leadDays })}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 px-4 py-3.5">
          <Button size="sm" variant="primary" onClick={open} disabled={busy}>
            {t("series.move")}
          </Button>
          {date ? (
            <>
              <Button size="sm" variant="ghost" loading={busy} onClick={onSpawn}>
                {t("series.createNow")}
              </Button>
              {cadenceDays === null ? null : (
                <Button size="sm" variant="ghost" onClick={onSkip} disabled={busy}>
                  {t("series.skip")}
                </Button>
              )}
            </>
          ) : null}
        </div>
      </section>

      {moving ? (
        <Sheet title={t("series.moveTitle")} onClose={() => setMoving(false)}>
          <div className="flex flex-col gap-4">
            <Field label={t("series.next")} hint={t("series.moveHint")}>
              <TextInput
                type="datetime-local"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </Field>
            {nextStartsAt ? (
              <button
                type="button"
                className="self-start text-[12px] underline decoration-current/40 underline-offset-2"
                style={{ color: "var(--danger)" }}
                onClick={() => {
                  setMoving(false);
                  onMove(null);
                }}
              >
                {t("series.clearDate")}
              </button>
            ) : null}
            <SheetFooter>
              <Button
                block
                disabled={draft === ""}
                onClick={() => {
                  setMoving(false);
                  onMove(fromLocalInput(draft));
                }}
              >
                {t("common.save")}
              </Button>
            </SheetFooter>
          </div>
        </Sheet>
      ) : null}
    </>
  );
};
