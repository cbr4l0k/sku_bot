import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { CITIES, cityList, type CitySlug } from "@sku/cities";

import { sku, type AdminEventDraft, type AdminUser, type Group } from "../api";
import { useI18n } from "../i18n";
import { useSession } from "../session";
import { bib, errorText, fullName, percent } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { DateBlock, EventStatusChip } from "../ui/event";
import { EventForm } from "../ui/eventForm";
import { GroupChips } from "../ui/groups";
import { Sheet, useConfirm, useToast } from "../ui/overlays";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Loader,
  MiniBar,
  PageTitle,
  Screen,
  SearchInput,
  SectionRule,
  StatTile,
} from "../ui/primitives";

type Tab = "events" | "users" | "chats" | "stats";

const TABS: { id: Tab; key: "admin.tabEvents" | "admin.tabUsers" | "admin.tabChats" | "admin.tabStats" }[] = [
  { id: "events", key: "admin.tabEvents" },
  { id: "users", key: "admin.tabUsers" },
  { id: "chats", key: "admin.tabChats" },
  { id: "stats", key: "admin.tabStats" },
];

/** The branch dot every city-bearing row wears, so a list scans by colour. */
const CityDot = ({ city }: { city: CitySlug }) => (
  <span
    aria-hidden
    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
    style={{ background: CITIES[city].brandLift, boxShadow: `0 0 0 2px ${CITIES[city].brand}` }}
  />
);

/* --------------------------------------------------------------- events tab */

const EventsTab = ({
  availableGroups,
  cities,
  onCityChange,
}: {
  availableGroups: readonly Group[];
  cities: readonly CitySlug[];
  onCityChange: (city: CitySlug) => void;
}) => {
  const { t } = useI18n();
  const toast = useToast();
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const events = useResource(sku.organizerEvents);

  const create = (draft: AdminEventDraft) =>
    void action.run(
      async () => {
        await sku.createEvent({ ...draft, status: "draft" });
        toast(t("common.saved"));
        setCreating(false);
        await events.reload(true);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  return (
    <>
      <Button block className="mb-4" onClick={() => setCreating(true)}>
        + {t("admin.newEvent")}
      </Button>

      {events.loading && !events.data ? <Loader label={t("common.loading")} /> : null}
      {events.error && !events.data ? (
        <ErrorState
          message={errorText(t, events.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void events.reload()}
        />
      ) : null}
      {events.data && events.data.length === 0 ? <EmptyState text={t("events.empty")} /> : null}

      <div className="flex flex-col gap-3">
        {(events.data ?? []).map((event, index) => (
          <Link
            key={event.id}
            to={`/admin/events/${event.id}`}
            style={{ "--i": index } as React.CSSProperties}
            className="card rise flex gap-3.5 px-4 py-4 active:scale-[0.985]"
          >
            <DateBlock iso={event.startsAt} />
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-start justify-between gap-2">
                <h3 className="display min-w-0 text-[16px] leading-tight break-words">{event.title}</h3>
                <span className="num shrink-0 text-[10px] tracking-[0.2em] text-hint opacity-60">{bib(event.id)}</span>
              </div>
              <p className="mb-2.5 truncate text-[13px] text-hint">{event.location}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {event.endedAt ? <Chip>{t("organizer.ended")}</Chip> : <EventStatusChip status={event.status} />}
                <GroupChips groups={event.groups} />
              </div>
            </div>
          </Link>
        ))}
      </div>

      {creating ? (
        <Sheet title={t("admin.newEvent")} onClose={() => setCreating(false)}>
          <EventForm
            submitLabel={t("form.create")}
            pending={action.pending}
            availableGroups={availableGroups}
            cities={cities}
            onCityChange={onCityChange}
            onSubmit={create}
          />
        </Sheet>
      ) : null}
    </>
  );
};

/* ---------------------------------------------------------------- users tab */

/**
 * Appointing someone to a branch. Only the branches the viewer runs are offered,
 * and a branch admin is never editable here — unseating one is the club's call,
 * which the server enforces regardless of what this renders.
 */
const RoleEditor = ({ person, cities, onChanged }: { person: AdminUser; cities: readonly CitySlug[]; onChanged: () => void }) => {
  const { t, locale } = useI18n();
  const toast = useToast();
  const action = useAction();
  const roleIn = (city: CitySlug) => person.roles.find((role) => role.city === city)?.role ?? null;

  const set = (city: CitySlug, role: "admin" | "organizer" | null) =>
    void action.run(
      async () => {
        await sku.setCityRole(person.id, city, role);
        toast(t("toast.roleSaved"), "ok");
        onChanged();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  if (cities.length === 0) return null;

  return (
    <div className="mt-2.5 flex flex-col gap-1.5">
      {cities.map((city) => {
        const current = roleIn(city);
        return (
          <div key={city} className="flex items-center gap-2">
            <CityDot city={city} />
            <span className="min-w-0 flex-1 truncate text-[12px] text-hint">{CITIES[city].name[locale]}</span>
            {(["admin", "organizer", null] as const).map((role) => (
              <button
                key={role ?? "none"}
                type="button"
                disabled={action.pending}
                aria-pressed={current === role}
                onClick={() => (current === role ? undefined : set(city, role))}
                className={`chip ${current === role ? "chip-flare" : ""} disabled:opacity-50`}
              >
                {t(role === "admin" ? "role.admin" : role === "organizer" ? "role.organizer" : "role.none")}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
};

const UserRow = ({ person, index, cities, onChanged }: { person: AdminUser; index: number; cities: readonly CitySlug[]; onChanged: () => void }) => {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();

  const run = (task: () => Promise<unknown>) =>
    void action.run(
      async () => {
        await task();
        onChanged();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const toggleBan = async () => {
    const text = person.isBanned ? t("admin.confirmUnban") : t("admin.confirmBan");
    if (!(await confirm({ text, danger: !person.isBanned }))) return;
    run(() => (person.isBanned ? sku.unban(person.id) : sku.ban(person.id)));
  };

  return (
    <div style={{ "--i": index } as React.CSSProperties} className="rise border-b border-hair px-1 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px]">{fullName(person)}</div>
          <div className="num mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-hint">
            {person.username ? <span className="break-all">@{person.username}</span> : null}
            {person.phone ? <span className="break-all">{person.phone}</span> : null}
            <span>{t("admin.registrationsCount", { n: person.registrationCount })}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {person.isAdmin ? <Chip tone="flare">{t("admin.admin")}</Chip> : null}
          {person.roles.map((role) => (
            <Chip key={role.city} tone={role.role === "admin" ? "flare" : "soft"}>
              {`${CITIES[role.city].name[locale]} · ${t(role.role === "admin" ? "role.admin" : "role.organizer")}`}
            </Chip>
          ))}
          {person.isBanned ? <Chip tone="plain">{t("admin.banned")}</Chip> : null}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button size="sm" variant={person.isBanned ? "ghost" : "danger"} loading={action.pending} onClick={() => void toggleBan()}>
          {person.isBanned ? t("admin.unban") : t("admin.ban")}
        </Button>
        {person.isConfiguredAdmin ? (
          <span className="self-center text-[11px] text-hint">{t("admin.configuredAdmin")}</span>
        ) : person.isAdmin ? (
          <Button size="sm" variant="ghost" loading={action.pending} onClick={() => run(() => sku.demote(person.id))}>
            {t("admin.demote")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" loading={action.pending} onClick={() => run(() => sku.promote(person.id))}>
            {t("admin.promote")}
          </Button>
        )}
      </div>
      <RoleEditor person={person} cities={cities} onChanged={onChanged} />
    </div>
  );
};

const UsersTab = ({ cities }: { cities: readonly CitySlug[] }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query]);

  const users = useResource(useCallback(() => sku.users(debounced || undefined), [debounced]));

  return (
    <>
      <SearchInput
        className="mb-4"
        placeholder={t("common.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {users.loading && !users.data ? <Loader label={t("common.loading")} /> : null}
      {users.error && !users.data ? (
        <ErrorState message={errorText(t, users.error)} retryLabel={t("common.retry")} onRetry={() => void users.reload()} />
      ) : null}
      {users.data && users.data.length === 0 ? <EmptyState text={t("admin.usersEmpty")} /> : null}
      {users.data && users.data.length > 0 ? (
        <section className="card px-4 py-1">
          {users.data.map((person, index) => (
            <UserRow key={person.id} person={person} index={index} cities={cities} onChanged={() => void users.reload(true)} />
          ))}
        </section>
      ) : null}
    </>
  );
};

/* ---------------------------------------------------------------- stats tab */

const StatsTab = () => {
  const { t } = useI18n();
  const stats = useResource(sku.globalStats);

  if (stats.loading && !stats.data) return <Loader label={t("common.loading")} />;
  if (!stats.data) {
    return (
      <ErrorState message={errorText(t, stats.error)} retryLabel={t("common.retry")} onRetry={() => void stats.reload()} />
    );
  }

  const data = stats.data;

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <StatTile label={t("admin.globalEvents")} value={String(data.totalEvents)} />
        <StatTile label={t("admin.globalParticipants")} value={String(data.uniqueParticipants)} />
      </div>
      <section className="card mt-3 px-4 py-4">
        <MiniBar label={t("admin.globalFill")} value={percent(data.avgFillRate)} ratio={data.avgFillRate} />
        <MiniBar label={t("admin.globalAttendance")} value={percent(data.attendanceRate)} ratio={data.attendanceRate} />
      </section>

      {data.topParticipants.length > 0 ? (
        <>
          <SectionRule label={t("admin.topParticipants")} />
          <section className="card px-4 py-2">
            {data.topParticipants.map((person, index) => (
              <div key={person.userId} className="flex items-center gap-3 border-b border-hair py-2.5 last:border-b-0">
                <span className="num w-6 text-[12px] text-hint">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[14px]">{person.firstName}</span>
                <span className="num text-[13px]">{person.count}</span>
              </div>
            ))}
          </section>
        </>
      ) : null}
    </>
  );
};

/* ---------------------------------------------------------------- chats tab */

/**
 * The chat catalog. The bot files a chat the moment it is added to one, so this
 * list fills itself; the job here is only to say which branch each belongs to.
 * Until it has one, a chat is inert — no event can reach it.
 */
const ChatsTab = () => {
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
        toast(t("toast.chatFiled"), "ok");
        await catalog.reload(true);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const unassigned = chats.filter((chat) => chat.city === null);
  const filed = chats.filter((chat) => chat.city !== null);

  const row = (chat: (typeof chats)[number], index: number) => (
    <div key={chat.id} style={{ "--i": index } as React.CSSProperties} className="rise border-b border-hair px-1 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {chat.city ? <CityDot city={chat.city} /> : null}
            <span className="truncate text-[14px]">{chat.title ?? String(chat.id)}</span>
          </div>
          <div className="num mt-0.5 text-[11px] text-hint">{chat.id}</div>
          {chat.problem ? <div className="mt-1 text-[11px]" style={{ color: "var(--danger)" }}>{chat.problem}</div> : null}
        </div>
      </div>
      {canAssign ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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

  if (catalog.loading && !catalog.data) return <Loader label={t("common.loading")} />;
  if (chats.length === 0) return <EmptyState text={t("admin.chatsEmpty")} />;

  return (
    <>
      {canAssign ? null : <p className="mb-4 text-[12px] text-hint">{t("admin.chatsReadOnly")}</p>}
      {unassigned.length ? (
        <section className="mb-5">
          <SectionRule label={t("admin.chatsUnassigned")} />
          <p className="mb-2 text-[12px] text-hint">{t("admin.chatsUnassignedHint")}</p>
          {unassigned.map(row)}
        </section>
      ) : null}
      {filed.map(row)}
    </>
  );
};

/* -------------------------------------------------------------------- screen */

export const AdminScreen = () => {
  const { t } = useI18n();
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>("events");
  // The branches this admin runs; a general admin runs all of them.
  const myCities = me?.adminCities ?? [];
  const [formCity, setFormCity] = useState<CitySlug | null>(null);
  const activeCity = formCity ?? myCities[0] ?? null;
  const catalog = useResource(
    useCallback(() => (activeCity ? sku.groupCatalog(activeCity) : Promise.resolve({ groups: [] })), [activeCity]),
  );
  const availableGroups = catalog.data?.groups ?? [];

  return (
    <Screen>
      <PageTitle title={t("admin.title")} />

      <div className="mb-5 flex gap-1.5 rounded-full border border-hair p-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            data-active={tab === item.id}
            className="tab min-w-0 flex-1 flex-row justify-center py-2"
          >
            <span className="max-w-full truncate">{t(item.key)}</span>
          </button>
        ))}
      </div>

      {tab === "events" ? <EventsTab availableGroups={availableGroups} cities={myCities} onCityChange={setFormCity} /> : null}
      {tab === "users" ? <UsersTab cities={myCities} /> : null}
      {tab === "chats" ? <ChatsTab /> : null}
      {tab === "stats" ? <StatsTab /> : null}
    </Screen>
  );
};
