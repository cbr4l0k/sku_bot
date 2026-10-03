import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { CITIES, cityList, type CitySlug } from "@sku/cities";

import { sku, type Attention } from "../api";
import { useI18n } from "../i18n";
import { errorText, fullName, initials, money, monthSince, percent, shortDate } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { useToast } from "../ui/overlays";
import { PersonSheet } from "../ui/person";
import { Button, Chip, EmptyState, ErrorState, Loader, SearchInput } from "../ui/primitives";

const Rule = ({ label, aside }: { label: string; aside?: string }) => (
  <div className="mt-[26px] mb-3 flex items-center gap-3">
    <span className="eyebrow shrink-0">{label}</span>
    <span className="hairline flex-1" />
    {aside ? <span className="num shrink-0 text-[11px] text-hint">{aside}</span> : null}
  </div>
);

const Tile = ({ label, value }: { label: string; value: string }) => (
  <div className="stattile px-3.5 py-3">
    <div className="eyebrow mb-1">{label}</div>
    <div className="display text-[24px]">{value}</div>
  </div>
);

/* ---------------------------------------------------------- needs attention */

/** What only an admin can unblock: chats with no branch, drafts, refunds that bounced. */
export const NeedsAttention = ({ onAssignChats }: { onAssignChats: () => void }) => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const attention = useResource(sku.attention, { pollMs: 60_000 });
  if (!attention.data) return null;
  const { unassignedChats, seriesDrafts, failedRefunds }: Attention = attention.data;
  const count = (unassignedChats.length ? 1 : 0) + seriesDrafts.length + failedRefunds.length;
  if (count === 0) return null;

  return (
    <>
      <Rule label={t("attention.title")} aside={String(count)} />
      <section className="card rise">
        {unassignedChats.length ? (
          <div className="row">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">{t("attention.chats", { n: unassignedChats.length })}</div>
              <div className="text-[12px] text-hint">{t("attention.chatsHint")}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={onAssignChats}>
              {t("attention.assign")}
            </Button>
          </div>
        ) : null}
        {seriesDrafts.map((draft) => (
          <div key={draft.eventId} className="row">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold">
                {draft.title} · {shortDate(draft.startsAt, locale)}
              </div>
              <div className="text-[12px] text-hint">{t("hq.todoDraft")}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => navigate(`/hq/events/${draft.eventId}`)}>
              {t("hq.open")}
            </Button>
          </div>
        ))}
        {failedRefunds.map((refund) => (
          <div key={refund.orderId} className="row" style={{ background: "var(--danger-bg)" }}>
            <div className="min-w-0 flex-1" style={{ color: "var(--danger)" }}>
              <div className="text-[14px] font-semibold">{t("attention.refundFailed")}</div>
              <div className="text-[12px]">
                {[refund.eventTitle, money(refund.amountMinor, locale, refund.currency), refund.failureReason ? `YooKassa: ${refund.failureReason}` : null].filter(Boolean).join(" · ")}
              </div>
            </div>
            <Button size="sm" variant="danger" onClick={() => navigate(`/hq/events/${refund.eventId}`)}>
              {t("attention.resolve")}
            </Button>
          </div>
        ))}
      </section>
    </>
  );
};

/** This calendar month at a glance, under the admin's events. */
export const MonthNumbers = () => {
  const { t, locale } = useI18n();
  const stats = useResource(useCallback(() => sku.globalStats(), []));
  const month = stats.data?.month;
  if (!month) return null;
  const label = monthSince(`${month.month}-15T12:00:00Z`, locale);
  return (
    <>
      <Rule label={t("numbers.month", { month: label.charAt(0).toUpperCase() + label.slice(1) })} />
      <div className="grid grid-cols-3 gap-2">
        <Tile label={t("numbers.events")} value={String(month.events)} />
        <Tile label={t("numbers.runners")} value={String(month.runners)} />
        <Tile label={t("profile.turnout")} value={month.turnout === null ? "—" : percent(month.turnout)} />
      </div>
    </>
  );
};

/* ------------------------------------------------------------------- people */

export const PeopleTab = () => {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query]);
  const users = useResource(useCallback(() => sku.users(debounced || undefined), [debounced]));

  return (
    <>
      <SearchInput className="mb-3" placeholder={t("people.search")} aria-label={t("people.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
      {users.loading && !users.data ? <Loader label={t("common.loading")} /> : null}
      {users.error && !users.data ? <ErrorState message={errorText(t, users.error)} retryLabel={t("common.retry")} onRetry={() => void users.reload()} /> : null}
      {users.data && users.data.length === 0 ? <EmptyState text={t("admin.usersEmpty")} /> : null}
      {users.data && users.data.length > 0 ? (
        <section className="card">
          {users.data.map((person) => (
            <button key={person.id} type="button" className="row" onClick={() => setOpen(person.id)}>
              <span className="av">{initials(person)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold">{fullName(person)}</span>
                <span className="num block truncate text-[11px] text-hint">
                  {[
                    person.username ? `@${person.username}` : null,
                    t("admin.registrationsCount", { n: person.registrationCount }),
                    ...person.roles.map((role) => `${CITIES[role.city].name[locale]} · ${t(role.role === "admin" ? "role.admin" : "role.organizer")}`),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {person.isBanned ? <Chip>{t("admin.banned")}</Chip> : person.isAdmin ? <Chip tone="flare">{t("admin.admin")}</Chip> : null}
              <span className="chev">›</span>
            </button>
          ))}
        </section>
      ) : null}
      {open !== null ? <PersonSheet userId={open} onClose={() => setOpen(null)} onChanged={() => void users.reload(true)} /> : null}
    </>
  );
};

/* -------------------------------------------------------------------- chats */

/**
 * The chat catalog. The bot files a chat the moment it is added to one; the job
 * here is only to say which branch each belongs to. Until it has one, a chat is
 * inert — no event can reach it.
 */
export const ChatsTab = () => {
  const { t, locale } = useI18n();
  const toast = useToast();
  const action = useAction();
  const catalog = useResource(sku.chatCatalog);
  const chats = catalog.data?.chats ?? [];
  const canAssign = catalog.data?.canAssign ?? false;

  const file = (id: number, city: CitySlug | null) =>
    void action.run(
      async () => {
        await sku.setChatCity(id, city);
        toast(t("toast.chatFiled"));
        await catalog.reload(true);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  if (catalog.loading && !catalog.data) return <Loader label={t("common.loading")} />;
  if (chats.length === 0) return <EmptyState text={t("admin.chatsEmpty")} />;

  const unassigned = chats.filter((chat) => chat.city === null);
  const filed = chats.filter((chat) => chat.city !== null);
  const row = (chat: (typeof chats)[number]) => (
    <div key={chat.id} className="row block">
      <div className="flex items-center gap-2">
        {chat.city ? <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CITIES[chat.city].brand }} /> : null}
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{chat.title ?? String(chat.id)}</span>
        <span className="num text-[10px] text-hint">{chat.id}</span>
      </div>
      {chat.problem ? (
        <div className="mt-1 text-[11px]" style={{ color: "var(--danger)" }}>
          {chat.problem}
        </div>
      ) : null}
      {canAssign ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {cityList.map((city) => (
            <button
              key={city.slug}
              type="button"
              disabled={action.pending}
              aria-pressed={chat.city === city.slug}
              onClick={() => (chat.city === city.slug ? undefined : file(chat.id, city.slug))}
              className={`chip ${chat.city === city.slug ? "chip-flare" : ""} disabled:opacity-50`}
            >
              {city.name[locale]}
            </button>
          ))}
          {chat.city ? (
            <button type="button" disabled={action.pending} onClick={() => file(chat.id, null)} className="chip disabled:opacity-50">
              {t("admin.chatUnfile")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      {canAssign ? null : <p className="mb-3 text-[12px]" style={{ color: "var(--ink-deep)" }}>{t("admin.chatsReadOnly")}</p>}
      {unassigned.length ? (
        <>
          <Rule label={t("admin.chatsUnassigned")} aside={String(unassigned.length)} />
          <p className="mx-1 mb-3 text-[12px]" style={{ color: "var(--ink-deep)" }}>
            {t("admin.chatsUnassignedHint")}
          </p>
          <section className="card">{unassigned.map(row)}</section>
        </>
      ) : null}
      {filed.length ? (
        <>
          <Rule label={t("chats.filed")} aside={String(filed.length)} />
          <section className="card">{filed.map(row)}</section>
        </>
      ) : null}
    </>
  );
};

/* ------------------------------------------------------------------ numbers */

export const NumbersTab = () => {
  const { t } = useI18n();
  const stats = useResource(useCallback(() => sku.globalStats(), []));
  if (!stats.data) {
    return stats.loading ? (
      <Loader label={t("common.loading")} />
    ) : (
      <ErrorState message={errorText(t, stats.error)} retryLabel={t("common.retry")} onRetry={() => void stats.reload()} />
    );
  }
  const data = stats.data;
  return (
    <>
      <MonthNumbers />
      <Rule label={t("numbers.allTime")} />
      <div className="grid grid-cols-2 gap-2">
        <Tile label={t("admin.globalEvents")} value={String(data.totalEvents)} />
        <Tile label={t("admin.globalParticipants")} value={String(data.uniqueParticipants)} />
        <Tile label={t("admin.globalFill")} value={percent(data.avgFillRate)} />
        <Tile label={t("admin.globalAttendance")} value={percent(data.attendanceRate)} />
      </div>
      {data.topParticipants.length > 0 ? (
        <>
          <Rule label={t("admin.topParticipants")} />
          <section className="card">
            {data.topParticipants.map((person, index) => (
              <div key={person.userId} className="row">
                <span className="num w-6 shrink-0 text-[12px] text-hint">{index + 1}</span>
                <span className="av">{initials(person)}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{person.firstName}</span>
                <span className="num text-[13px]">{person.count}</span>
              </div>
            ))}
          </section>
        </>
      ) : null}
    </>
  );
};
