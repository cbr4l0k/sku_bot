import { Link, useSearchParams } from "react-router";

import { sku, type Hq } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { dayMonth, errorText, money, relativeDayKey, shortDate } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { useSession } from "../session";
import { haptic } from "../telegram";
import { PhaseChip } from "../ui/event";
import { useConfirm, useToast } from "../ui/overlays";
import { Button, EmptyState, ErrorState, Loader, PageTitle, Screen } from "../ui/primitives";
import { SeriesList } from "./Series";

type Tab = "events" | "series";

const TABS: ReadonlyArray<{ id: Tab; key: MessageKey }> = [
  { id: "events", key: "hq.tabEvents" },
  { id: "series", key: "series.title" },
];

/**
 * One tab for everyone who runs things. It opens on what is live and what needs
 * a person; the role decides what else is reachable from here.
 */
export const HqScreen = () => {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "series" ? "series" : "events";

  return (
    <Screen>
      <PageTitle title={t("hq.title")} />
      <div className="seg mb-[18px]" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className="tab"
            data-active={tab === item.id}
            onClick={() => {
              haptic.select();
              setParams(item.id === "events" ? {} : { tab: item.id }, { replace: true });
            }}
          >
            {t(item.key)}
          </button>
        ))}
      </div>
      {tab === "events" ? <HqEvents /> : <SeriesList />}
    </Screen>
  );
};

/** The event screen an organizer runs a run from. */
export const manageHref = (id: number) => `/hq/events/${id}`;

const HqEvents = () => {
  const { t } = useI18n();
  const { me } = useSession();
  const hq = useResource(sku.hq, { pollMs: 30_000 });
  const isAdmin = Boolean(me?.isAdmin || me?.adminCities.length);
  // Publishing is the branch's call, so it is checked per draft, not per person.
  const canPublish = (city: string) => Boolean(me?.isAdmin || me?.adminCities.some((own) => own === city));

  if (!hq.data) {
    return hq.loading ? (
      <Loader label={t("common.loading")} />
    ) : (
      <ErrorState message={errorText(t, hq.error)} retryLabel={t("common.retry")} onRetry={() => void hq.reload()} />
    );
  }

  const { live, todo, next } = hq.data;
  const reload = () => hq.reload(true);

  return (
    <>
      {live.length + todo.length + next.length === 0 ? <EmptyState text={t("hq.empty")} /> : null}

      <div className="flex flex-col gap-2.5">
        {live.map((event) => (
          <LiveCard key={event.id} event={event} />
        ))}
      </div>

      {todo.length > 0 ? (
        <>
          <Rule label={t("hq.todo")} aside={String(todo.length)} />
          <div className="card rise">
            {todo.map((item) => (
              <TodoRow key={`${item.kind}-${item.eventId}`} item={item} canPublish={item.kind === "publish_draft" && canPublish(item.city)} onDone={reload} />
            ))}
          </div>
        </>
      ) : null}

      {next.length > 0 ? (
        <>
          <Rule label={t("hq.next")} />
          <div className="card rise">
            {next.map((event) => (
              <NextRow key={event.id} event={event} />
            ))}
          </div>
        </>
      ) : null}

      <div className="card mt-7">
        <Link to="/hq/all" className="row">
          <span className="flex-1 text-[14px]">{t("hq.allEvents")}</span>
          <span className="chev">›</span>
        </Link>
        {isAdmin ? (
          <Link to="/admin" className="row">
            <span className="flex-1 text-[14px]">{t("hq.admin")}</span>
            <span className="chev">›</span>
          </Link>
        ) : null}
      </div>
    </>
  );
};

const Rule = ({ label, aside }: { label: string; aside?: string }) => (
  <div className="mt-[26px] mb-3 flex items-center gap-3">
    <span className="eyebrow shrink-0">{label}</span>
    <span className="hairline flex-1" />
    {aside ? <span className="num shrink-0 text-[11px] text-hint">{aside}</span> : null}
  </div>
);

/** What is running right now, in the deep tile: the count at the door is the whole point. */
const LiveCard = ({ event }: { event: Hq["live"][number] }) => {
  const { t } = useI18n();
  const started = event.minutesSinceStart >= 0;
  return (
    <Link to={manageHref(event.id)} className="stattile rise block p-[18px]">
      <div className="eyebrow mb-2.5">
        {started ? t("hq.liveFor", { n: event.minutesSinceStart }) : t("hq.startsIn", { n: -event.minutesSinceStart })}
      </div>
      <h2 className="display mb-3.5 text-[20px] break-words">{event.title}</h2>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="display text-[34px]">{event.checkedIn}</span>
        <span className="num text-[13px] text-hint">{t("hq.checkedInOf", { n: event.total })}</span>
      </div>
      <div className="track mb-4">
        <div className="track-fill" style={{ width: `${event.total ? Math.min(100, (event.checkedIn / event.total) * 100) : 0}%` }} />
      </div>
      <span className="btn btn-primary w-full">{t("hq.openStart")}</span>
    </Link>
  );
};

const TodoRow = ({ item, canPublish, onDone }: { item: Hq["todo"][number]; canPublish: boolean; onDone: () => Promise<void> }) => {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  const relative = relativeDayKey(item.startsAt);
  const when = relative ? t(relative).toLowerCase() : shortDate(item.startsAt, locale);

  const publish = () =>
    void action.run(
      async () => {
        await sku.adminUpdateEvent(item.eventId, { status: "published" });
        toast(t("hq.published"));
        await onDone();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const end = async () => {
    if (!(await confirm({ text: t("organizer.confirmEnd"), confirmLabel: t("hq.end") }))) return;
    void action.run(
      async () => {
        await sku.endEvent(item.eventId);
        toast(t("hq.ended"));
        await onDone();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  return (
    <div className="row">
      <Link to={manageHref(item.eventId)} className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold">
          {item.title} · {when}
        </div>
        <div className="text-[12px] text-hint">
          {item.kind === "publish_draft" ? t("hq.todoDraft") : t("hq.todoEnd", { n: item.hoursSinceStart })}
        </div>
      </Link>
      {item.kind === "end_event" ? (
        <Button size="sm" variant="ghost" loading={action.pending} onClick={() => void end()}>
          {t("hq.end")}
        </Button>
      ) : canPublish ? (
        <Button size="sm" loading={action.pending} onClick={publish}>
          {t("hq.publish")}
        </Button>
      ) : (
        <Link to={manageHref(item.eventId)} className="btn btn-primary btn-sm">
          {t("hq.open")}
        </Link>
      )}
    </div>
  );
};

const NextRow = ({ event }: { event: Hq["next"][number] }) => {
  const { t, locale } = useI18n();
  const seats = event.capacity === null ? String(event.registered) : `${event.registered}/${event.capacity}`;
  const detail =
    event.phase === "draft"
      ? event.capacity === null
        ? t("hq.draftNoLimit")
        : t("hq.draftSpots", { n: event.capacity })
      : [seats, event.waitlisted > 0 ? t("hq.waitlist", { n: event.waitlisted }) : null, event.revenueMinor !== null ? money(event.revenueMinor, locale) : null]
          .filter(Boolean)
          .join(" · ");
  return (
    <Link to={manageHref(event.id)} className="row">
      <span className="num w-11 shrink-0 text-[12px] text-hint">{dayMonth(event.startsAt, locale)}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold">{event.title}</span>
        <span className="num block text-[11px] text-hint">{detail}</span>
      </span>
      <PhaseChip phase={event.phase} closed={event.signupClosed} />
      <span className="chev">›</span>
    </Link>
  );
};
