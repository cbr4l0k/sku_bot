import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";

import { sku, type SeriesDetail, type SeriesDraft, type SeriesStats } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { dayMonth, errorText, fullName, initials, percent, timeOf, weekdayShort } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource } from "../lib/useResource";
import { haptic } from "../telegram";
import { PhaseChip } from "../ui/event";
import { LeadsSheet } from "../ui/eventAdmin";
import { Sheet, useConfirm, useToast } from "../ui/overlays";
import { Button, Chip, ErrorState, Loader, PersonName, Screen, SearchInput, SectionRule } from "../ui/primitives";
import { SeriesForm } from "../ui/seriesForm";
import { NextUpCard } from "../ui/seriesNext";
import { ShowUpChart } from "../ui/seriesTrend";
import { manageHref } from "./Hq";

const SESSIONS_SHOWN = 4;

export const SeriesDetailScreen = () => {
  const { t } = useI18n();
  const { id } = useParams();
  const seriesId = Number(id);
  useBackButton("/hq?tab=series");
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [pickingLeads, setPickingLeads] = useState(false);

  const detail = useResource(useCallback(() => sku.seriesDetail(seriesId), [seriesId]));
  const stats = useResource(useCallback(() => sku.seriesStats(seriesId), [seriesId]));
  const catalog = useResource(
    useCallback(() => (detail.data ? sku.groupCatalog(detail.data.city) : Promise.resolve({ groups: [] })), [detail.data]),
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

  if (!detail.data) {
    return (
      <Screen>
        {detail.loading ? (
          <Loader label={t("common.loading")} />
        ) : (
          <ErrorState message={errorText(t, detail.error)} retryLabel={t("common.retry")} onRetry={() => void detail.reload()} />
        )}
      </Screen>
    );
  }

  const series = detail.data;
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

  const cadence = series.cadenceDays === null ? t("series.byHand") : t("series.everyNDays", { n: series.cadenceDays });

  return (
    <Screen>
      <div className="eyebrow mb-2.5">
        {[t("series.eyebrow"), cadence, t("series.leadShort", { n: series.leadDays })].join(" · ")}
      </div>
      <h1 className="hero rise mb-5 break-words">{series.title}</h1>

      <NextUpCard
        occurrence={series.upcomingOccurrences.find((event) => event.status !== "canceled" && event.endedAt === null) ?? null}
        nextStartsAt={series.nextStartsAt}
        leadDays={series.leadDays}
        cadenceDays={series.cadenceDays}
        manageHref={manageHref}
        busy={action.pending}
        onMove={(iso) => run(() => sku.updateSeries(seriesId, { nextStartsAt: iso }), t("toast.seriesSaved"))}
        onSpawn={() => run(() => sku.spawnOccurrence(seriesId), t("toast.occurrenceCreated"))}
        onSkip={() => {
          void (async () => {
            const ok = await confirm({ text: t("series.confirmSkip", { n: series.cadenceDays ?? 0 }), confirmLabel: t("series.skip") });
            if (ok) run(() => sku.skipOccurrence(seriesId), t("toast.skipped"));
          })();
        }}
      />

      {stats.data && stats.data.totals.held > 0 ? <Analytics stats={stats.data} /> : null}

      <Sessions series={series} />

      <SectionRule label={t("series.template")} />
      <Template series={series} onEdit={() => setEditing(true)} />
      <p className="mx-1 mt-2.5 text-[12px]" style={{ color: "var(--ink-deep)" }}>
        {t("series.templateHint")}
      </p>

      <SectionRule label={t("series.rhythm")} />
      <section className="card">
        <button type="button" className="row" onClick={() => setEditing(true)}>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">{t("series.cadence")}</span>
            <span className="block text-[12px] text-hint">
              {series.cadenceDays === null ? t("series.byHand") : t("series.cadenceLine", { n: series.cadenceDays })}
            </span>
          </span>
          <span className="chev">›</span>
        </button>
        <button type="button" className="row" onClick={() => setEditing(true)}>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">{t("series.lead")}</span>
            <span className="block text-[12px] text-hint">{t("series.leadLine", { n: series.leadDays })}</span>
          </span>
          <span className="chev">›</span>
        </button>
        <div className="row">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">{t("series.pause")}</span>
            <span className="block text-[12px] text-hint">{t("series.pauseHint")}</span>
          </span>
          <button
            type="button"
            className="switch"
            aria-pressed={!series.active}
            aria-label={t("series.pause")}
            disabled={action.pending}
            onClick={() => {
              haptic.select();
              run(() => sku.updateSeries(seriesId, { active: !series.active }), t("toast.seriesSaved"));
            }}
          >
            <span />
          </button>
        </div>
      </section>

      <SectionRule label={t("series.running")} />
      <section className="card">
        <button type="button" className="row" onClick={() => setPickingLeads(true)}>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">{t("detail.ledBy")}</span>
            <span className="block truncate text-[12px] text-hint">{series.organizers.map(fullName).join(", ") || "—"}</span>
          </span>
          <span className="chev">›</span>
        </button>
        <div className="row">
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">{t("manage.waitlist")}</span>
            <span className="block text-[12px] text-hint">{t("manage.waitlistHint")}</span>
          </span>
          <button
            type="button"
            className="switch"
            aria-pressed={series.waitlistEnabled}
            aria-label={t("manage.waitlist")}
            disabled={action.pending}
            onClick={() => {
              haptic.select();
              run(() => sku.updateSeries(seriesId, { waitlistEnabled: !series.waitlistEnabled }), t("toast.seriesSaved"));
            }}
          >
            <span />
          </button>
        </div>
      </section>
      <p className="mx-1 mt-2.5 text-[12px]" style={{ color: "var(--ink-deep)" }}>
        {t("series.runningHint")}
      </p>

      {pickingLeads ? (
        <LeadsSheet
          hint={t("series.leadsHint")}
          initial={series.organizers}
          allowEmpty
          onSave={(organizerIds) => sku.updateSeries(seriesId, { organizerIds })}
          onClose={() => {
            setPickingLeads(false);
            void refresh();
          }}
        />
      ) : null}

      {editing ? (
        <Sheet title={t("series.editTemplate")} onClose={() => setEditing(false)}>
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

const Analytics = ({ stats }: { stats: SeriesStats }) => {
  const { t } = useI18n();
  const [everyone, setEveryone] = useState(false);
  const { totals, retention, regulars, participants } = stats;
  const preview = regulars.slice(0, 5);
  const people = retention.onceOnly + retention.twoToThree + retention.fourPlus;
  const buckets: ReadonlyArray<{ key: MessageKey; count: number }> = [
    { key: "series.retentionOnce", count: retention.onceOnly },
    { key: "series.retentionFew", count: retention.twoToThree },
    { key: "series.retentionMany", count: retention.fourPlus },
  ];
  return (
    <>
      <SectionRule label={t("series.stats")} />
      <div className="grid grid-cols-2 gap-2">
        <Tile label={t("series.statRuns")} value={String(totals.held)} />
        <Tile label={t("series.statPeople")} value={String(totals.uniqueParticipants)} />
        <Tile label={t("series.statAttendance")} value={percent(totals.turnout)} />
        <Tile label={t("series.statFill")} value={percent(totals.fillRate)} />
      </div>

      <section className="card mt-2.5 p-4">
        <div className="mb-3.5 flex items-baseline justify-between">
          <span className="eyebrow">{t("series.trend")}</span>
        </div>
        <ShowUpChart occurrences={stats.occurrences} />
        <div className="hairline my-3.5" />
        <div className="flex justify-between text-[13px]">
          <span>
            {t("series.newcomers")} <span className="num">{totals.firstTime}</span>
          </span>
          <span>
            {t("series.returning")} <span className="num">{totals.returning}</span>
          </span>
        </div>
      </section>

      {people > 0 ? (
        <section className="card mt-2.5 px-4 py-3">
          <div className="eyebrow mt-1 mb-1.5">{t("series.retention")}</div>
          {buckets.map((bucket) => (
            <div key={bucket.key} className="py-1.5">
              <div className="mb-1.5 flex justify-between text-[13px]">
                <span>{t(bucket.key)}</span>
                <span className="num">{percent(bucket.count / people)}</span>
              </div>
              <div className="track h-1.5">
                <div className="track-fill" style={{ width: `${(bucket.count / people) * 100}%` }} />
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {participants.length > 0 ? (
        <section className="card mt-2.5">
          {preview.length > 0 ? <div className="eyebrow px-4 pt-3.5 pb-1">{t("series.regulars")}</div> : null}
          {preview.map((person) => (
            <ParticipantRow key={person.userId} person={person} held={totals.held} />
          ))}
          <button type="button" className="row" onClick={() => setEveryone(true)}>
            <span className="flex-1 text-[13px]">{t("series.allParticipants", { n: participants.length })}</span>
            <span className="chev">›</span>
          </button>
        </section>
      ) : null}

      {everyone ? <ParticipantsSheet participants={participants} held={totals.held} onClose={() => setEveryone(false)} /> : null}
    </>
  );
};

type Participant = SeriesStats["participants"][number];

const ParticipantRow = ({ person, held, rank }: { person: Participant; held: number; rank?: number }) => {
  const { t } = useI18n();
  return (
    <div className="row">
      {rank === undefined ? null : <span className="num w-6 shrink-0 text-[12px] text-hint">{rank}</span>}
      <span className="av">{initials(person)}</span>
      <PersonName person={person} className="flex-1 text-[14px] font-semibold" />
      <span className="num shrink-0 text-[12px] text-hint">{t("series.attended", { n: person.attended, total: held })}</span>
    </div>
  );
};

/** Everyone who has held a spot in the series, most often first. */
const ParticipantsSheet = ({ participants, held, onClose }: { participants: readonly Participant[]; held: number; onClose: () => void }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const needle = query.trim().replace(/^@/, "").toLowerCase();
  const shown = participants
    .map((person, index) => ({ person, rank: index + 1 }))
    .filter(({ person }) => !needle || [fullName(person), person.username ?? ""].some((text) => text.toLowerCase().includes(needle)));
  return (
    <Sheet title={t("series.participants")} onClose={onClose} full>
      <p className="mb-3 text-[12px] leading-relaxed text-hint">{t("series.participantsHint")}</p>
      <SearchInput className="mb-3" placeholder={t("people.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {shown.length > 0 ? (
        <section className="card">
          {shown.map(({ person, rank }) => (
            <ParticipantRow key={person.userId} person={person} held={held} rank={rank} />
          ))}
        </section>
      ) : (
        <p className="py-6 text-center text-[13px] text-hint">{t("manage.listEmpty")}</p>
      )}
    </Sheet>
  );
};

const Tile = ({ label, value }: { label: string; value: string }) => (
  <div className="stattile px-3.5 py-3">
    <div className="eyebrow mb-1">{label}</div>
    <div className="display text-[26px]">{value}</div>
  </div>
);

/** Every run raised from this series, newest first; past ones are just a record. */
const Sessions = ({ series }: { series: SeriesDetail }) => {
  const { t, locale } = useI18n();
  const [all, setAll] = useState(false);
  const rows = [...[...series.upcomingOccurrences].reverse(), ...[...series.pastOccurrences].reverse()];
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, SESSIONS_SHOWN);
  const held = series.pastOccurrences.filter((event) => event.endedAt !== null && event.status !== "canceled").length;

  return (
    <>
      <div className="mt-[26px] mb-3 flex items-center gap-3">
        <span className="eyebrow shrink-0">{t("series.occurrences")}</span>
        <span className="hairline flex-1" />
        <span className="num shrink-0 text-[11px] text-hint">
          {series.upcomingOccurrences.length ? `${held} + ${series.upcomingOccurrences.length}` : held}
        </span>
      </div>
      <div className="card">
        {shown.map((event) => (
          <Link key={event.id} to={manageHref(event.id)} className="row">
            <span className="num w-11 shrink-0 text-[12px] text-hint">{dayMonth(event.startsAt, locale)}</span>
            <span className="min-w-0 flex-1 truncate text-[14px]">{event.title}</span>
            {event.status === "canceled" ? (
              <PhaseChip phase="canceled" />
            ) : event.endedAt ? (
              <Chip>{t("series.held")}</Chip>
            ) : (
              <PhaseChip phase={event.status === "draft" ? "draft" : "signup"} closed={event.status === "closed"} />
            )}
          </Link>
        ))}
        {rows.length > SESSIONS_SHOWN && !all ? (
          <button type="button" className="row" onClick={() => setAll(true)}>
            <span className="flex-1 text-[13px]">{t("series.allSessions")}</span>
            <span className="chev">›</span>
          </button>
        ) : null}
      </div>
    </>
  );
};

const Template = ({ series, onEdit }: { series: SeriesDetail; onEdit: () => void }) => {
  const { t, locale } = useI18n();
  const tiers = series.ticketTiers.filter((tier) => tier.active).length;
  const products = series.products.filter((product) => product.active).length;
  const rows: ReadonlyArray<{ key: MessageKey; value: string }> = [
    {
      key: "detail.when",
      value: series.nextStartsAt ? `${weekdayShort(series.nextStartsAt, locale)}, ${timeOf(series.nextStartsAt, locale)}` : "—",
    },
    { key: "detail.where", value: series.location },
    {
      key: "detail.spots",
      value: [
        series.capacity === null ? t("events.freeEntry") : String(series.capacity),
        t(series.waitlistEnabled ? "series.waitlistOn" : "series.waitlistOff"),
      ].join(" · "),
    },
    {
      key: "detail.tickets",
      value:
        tiers === 0 && products === 0
          ? t("series.templateNothing")
          : [tiers ? t("series.templateTiers", { n: tiers }) : null, products ? t("series.templateProducts", { n: products }) : null].filter(Boolean).join(" · "),
    },
    { key: "series.chat", value: series.chats.map((chat) => chat.title).join(", ") || "—" },
    { key: "detail.ledBy", value: series.organizers.map(fullName).join(", ") || "—" },
  ];
  return (
    <section className="card">
      {rows.map((row) => (
        <div key={row.key} className="row">
          <span className="eyebrow w-[86px] shrink-0 text-[9px]">{t(row.key)}</span>
          <span className="min-w-0 flex-1 text-[13px] break-words">{row.value}</span>
        </div>
      ))}
      <div className="px-4 pt-3 pb-4">
        <Button variant="ghost" block onClick={onEdit}>
          {t("series.editTemplate")}
        </Button>
      </div>
    </section>
  );
};
