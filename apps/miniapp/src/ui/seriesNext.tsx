import { useState } from "react";
import { Link } from "react-router";

import type { SeriesDetail } from "../api";
import { useI18n } from "../i18n";
import { fromLocalInput, shortDate, timeOf, toLocalInput } from "../lib/format";
import { DateBlock } from "./event";
import { Sheet, SheetFooter } from "./overlays";
import { Button, Field, TextInput } from "./primitives";

type Occurrence = SeriesDetail["upcomingOccurrences"][number];

/**
 * What comes next in a series, and the one action it wants. A run already
 * raised from the template is opened; otherwise the date a person approved is
 * shown with the controls that move it. The date is never derived — the
 * cadence only proposes the following one after a run is raised.
 */
export const NextUpCard = ({
  occurrence,
  nextStartsAt,
  leadDays,
  cadenceDays,
  manageHref,
  busy = false,
  onMove,
  onSpawn,
  onSkip,
}: {
  occurrence: Occurrence | null;
  nextStartsAt: string | null;
  leadDays: number;
  cadenceDays: number | null;
  manageHref: (id: number) => string;
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
  const isDraft = occurrence?.status === "draft";

  // The template's own controls; under a raised run they act on the date after it.
  const templateControls = nextStartsAt ? (
    <>
      <Button size="sm" variant="ghost" onClick={open} disabled={busy}>
        {t("series.move")}
      </Button>
      {cadenceDays === null ? null : (
        <Button size="sm" variant="ghost" onClick={onSkip} disabled={busy}>
          {t("series.skip")}
        </Button>
      )}
    </>
  ) : (
    <Button size="sm" variant="ghost" onClick={open} disabled={busy}>
      {t("series.setDate")}
    </Button>
  );

  return (
    <>
      <section className="card rise p-4">
        <div className="eyebrow mb-3">{t("series.next")}</div>
        {occurrence ? (
          <>
            <div className="flex items-center gap-3.5">
              <DateBlock iso={occurrence.startsAt} />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold break-words">{occurrence.title}</div>
                <p className="mt-1 text-[12px] text-hint">{isDraft ? t("series.draftReady") : t("series.published")}</p>
              </div>
            </div>
            <Link to={manageHref(occurrence.id)} className="btn btn-primary btn-sm mt-3.5 w-full">
              {isDraft ? t("series.openDraft") : t("hq.open")}
            </Link>
            <div className="hairline my-3.5" />
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-[12px] text-hint">
                {nextStartsAt
                  ? t("series.afterThat", { date: `${shortDate(nextStartsAt, locale)}, ${timeOf(nextStartsAt, locale)}`, n: leadDays })
                  : t("series.nextNone")}
              </p>
              {templateControls}
            </div>
          </>
        ) : nextStartsAt ? (
          <>
            <div className="flex items-center gap-3.5">
              <DateBlock iso={nextStartsAt} />
              <p className="min-w-0 flex-1 text-[12px] text-hint">{t("series.nextHint", { n: leadDays })}</p>
            </div>
            <div className="mt-3.5 grid grid-cols-[2fr_1fr_1fr] gap-2">
              <Button size="sm" loading={busy} onClick={onSpawn}>
                {t("series.createNow")}
              </Button>
              {templateControls}
            </div>
          </>
        ) : (
          <>
            <div className="display text-[20px]">{t("series.nextNone")}</div>
            <p className="mt-1 mb-3.5 text-[12px] text-hint">{t("series.nextNoneHint", { n: leadDays })}</p>
            <Button size="sm" block onClick={open} disabled={busy}>
              {t("series.setDate")}
            </Button>
          </>
        )}
      </section>

      {moving ? (
        <Sheet title={t("series.moveTitle")} onClose={() => setMoving(false)}>
          <div className="flex flex-col gap-4">
            <Field label={t("series.next")} hint={t("series.moveHint")}>
              <TextInput type="datetime-local" value={draft} onChange={(event) => setDraft(event.target.value)} />
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
