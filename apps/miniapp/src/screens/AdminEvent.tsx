import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { sku, type AdminEventDraft, type EventStatus } from "../api";
import { useI18n } from "../i18n";
import { bib, errorText, fullDate, fullName, percent } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource } from "../lib/useResource";
import { copyText } from "../telegram";
import { EventStatusChip } from "../ui/event";
import { EventForm } from "../ui/eventForm";
import { GroupChips } from "../ui/groups";
import { Sheet, SheetFooter, useConfirm, useToast } from "../ui/overlays";
import {
  Button,
  Chip,
  ErrorState,
  Loader,
  MiniBar,
  PageTitle,
  Screen,
  SearchInput,
  SectionRule,
  StatTile,
} from "../ui/primitives";

/* ------------------------------------------------------- organizer assignment */

const OrganizersSheet = ({ eventId, onClose }: { eventId: number; onClose: () => void }) => {
  const { t } = useI18n();
  const toast = useToast();
  const action = useAction();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const users = useResource(useCallback(() => sku.users(query.trim() || undefined), [query]));

  const save = () =>
    void action.run(
      async () => {
        await sku.setOrganizers(eventId, picked);
        toast(t("common.saved"));
        onClose();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  return (
    <Sheet title={t("admin.organizers")} onClose={onClose}>
      <p className="mb-3 text-[12px] leading-relaxed text-hint">{t("admin.organizersHint")}</p>
      <SearchInput
        className="mb-3"
        placeholder={t("common.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="mb-4 max-h-[45dvh] overflow-y-auto">
        {(users.data ?? []).map((person) => {
          const active = picked.includes(person.id);
          return (
            <button
              key={person.id}
              type="button"
              onClick={() =>
                setPicked((prev) => (active ? prev.filter((id) => id !== person.id) : [...prev, person.id]))
              }
              className="flex w-full items-center gap-3 border-b border-hair py-3 text-left last:border-b-0"
            >
              <span
                className="grid h-5 w-5 shrink-0 place-items-center rounded-md border"
                style={
                  active
                    ? { background: "var(--flare)", borderColor: "transparent", color: "var(--flare-ink)" }
                    : { borderColor: "var(--hair)" }
                }
              >
                {active ? "✓" : ""}
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px]">{fullName(person)}</span>
              {person.username ? <span className="num text-[11px] text-hint">@{person.username}</span> : null}
            </button>
          );
        })}
      </div>
      <SheetFooter>
        <Button block loading={action.pending} disabled={picked.length === 0} onClick={save}>
          {t("common.save")} · {picked.length}
        </Button>
      </SheetFooter>
    </Sheet>
  );
};

/* -------------------------------------------------------------------- screen */

export const AdminEventScreen = () => {
  const { t, locale } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  useBackButton("/admin");

  const id = Number(params.id);
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const events = useResource(sku.organizerEvents);
  const stats = useResource(useCallback(() => sku.eventStats(id), [id]));
  const catalog = useResource(sku.groupCatalog);

  const event = (events.data ?? []).find((item) => item.id === id) ?? null;

  const patch = (body: Partial<AdminEventDraft> & { status?: EventStatus }) =>
    void action.run(
      async () => {
        await sku.adminUpdateEvent(id, body);
        toast(t("common.saved"));
        setEditing(false);
        await Promise.all([events.reload(true), stats.reload(true)]);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const toggleQueue = async () => {
    if (event?.waitlistEnabled) {
      const waiting = stats.data?.waitlisted ?? 0;
      const text = waiting > 0 ? t("admin.confirmDisableQueueWaiting", { n: waiting }) : t("admin.confirmDisableQueue");
      if (!(await confirm({ text, confirmLabel: t("admin.disableQueue"), danger: true }))) return;
    }
    patch({ waitlistEnabled: !event?.waitlistEnabled });
  };

  const cancelEvent = async () => {
    if (!(await confirm({ text: t("admin.confirmCancel"), confirmLabel: t("admin.cancelEvent"), danger: true }))) return;
    patch({ status: "canceled" });
  };

  const removeDraft = async () => {
    if (!(await confirm({ text: t("admin.confirmDelete"), confirmLabel: t("common.delete"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.deleteEvent(id);
        navigate("/admin", { replace: true });
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  const copyLink = () =>
    void action.run(
      async () => {
        const link = await sku.eventLink(id);
        // The bot link works without a registered Mini App short name, and answers
        // with the event card and its sign-up button.
        await copyText(link.botLink);
        toast(t("common.copied"));
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  if (events.loading && !events.data) {
    return (
      <Screen>
        <Loader label={t("common.loading")} />
      </Screen>
    );
  }

  if (!event) {
    return (
      <Screen>
        <ErrorState message={t("err.event_not_found")} retryLabel={t("common.retry")} onRetry={() => void events.reload()} />
      </Screen>
    );
  }

  const data = stats.data;
  const noShow = data ? Math.max(0, data.registered - data.checkedIn) : 0;

  return (
    <Screen>
      <PageTitle
        title={event.title}
        aside={<EventStatusChip status={event.status} />}
      />

      <div className="mb-4">
        <p className="block truncate text-[13px] text-hint first-letter:uppercase">
          {fullDate(event.startsAt, locale)} · {event.location}
        </p>
        {event.groups.length > 0 || !event.waitlistEnabled ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {event.groups.length > 0 ? <span className="text-[11px] text-hint">{t("form.groups")}</span> : null}
            <GroupChips groups={event.groups} />
            {event.waitlistEnabled ? null : <Chip tone="plain">{t("admin.queueOff")}</Chip>}
          </div>
        ) : null}
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        {event.status !== "published" ? (
          <Button size="sm" loading={action.pending} onClick={() => patch({ status: "published" })}>
            {t("admin.publish")}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" loading={action.pending} onClick={() => patch({ status: "closed" })}>
            {t("admin.close")}
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={action.pending} onClick={() => void toggleQueue()}>
          {event.waitlistEnabled ? t("admin.disableQueue") : t("admin.enableQueue")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {t("common.edit")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAssigning(true)}>
          {t("admin.organizers")}
        </Button>
        <Button size="sm" variant="ghost" loading={action.pending} onClick={copyLink}>
          ⧉ {t("admin.copyLink")}
        </Button>
        {event.status === "draft" ? (
          <Button size="sm" variant="danger" loading={action.pending} onClick={() => void removeDraft()}>
            {t("admin.deleteDraft")}
          </Button>
        ) : null}
        {event.status !== "canceled" ? (
          <Button size="sm" variant="danger" loading={action.pending} onClick={() => void cancelEvent()}>
            {t("admin.cancelEvent")}
          </Button>
        ) : null}
      </div>

      <SectionRule label={t("admin.stats")} />

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              label={t("admin.statRegistered")}
              value={String(data.registered)}
              hint={event.capacity === null ? t("events.freeEntry") : `${t("common.of")} ${event.capacity}`}
            />
            <StatTile label={t("admin.statCheckedIn")} value={String(data.checkedIn)} />
            <StatTile label={t("admin.statWaitlisted")} value={String(data.waitlisted)} />
            <StatTile label={t("admin.statNoShow")} value={String(noShow)} hint={percent(data.noShowRate)} />
          </div>
          <section className="card mt-3 px-4 py-4">
            <MiniBar label={t("admin.statAttendance")} value={percent(data.attendanceRate)} ratio={data.attendanceRate} />
            <MiniBar
              label={t("admin.statConversion")}
              value={percent(data.waitlistConversion)}
              ratio={data.waitlistConversion}
            />
            <div className="mt-2">
              <Chip>{t("admin.statOffers", { a: data.offersAccepted, b: data.offersMade })}</Chip>
            </div>
          </section>
        </>
      ) : (
        <Loader label={t("common.loading")} />
      )}

      {editing ? (
        <Sheet title={t("common.edit")} onClose={() => setEditing(false)}>
          <EventForm
            initial={{
              title: event.title,
              description: event.description,
              startsAt: event.startsAt,
              location: event.location,
              locationUrl: event.locationUrl,
              capacity: event.capacity,
              groups: event.groups.map((group) => group.id),
            }}
            submitLabel={t("common.save")}
            pending={action.pending}
            availableGroups={catalog.data?.groups ?? []}
            onSubmit={(draft) => patch(draft)}
          />
        </Sheet>
      ) : null}

      {assigning ? <OrganizersSheet eventId={id} onClose={() => setAssigning(false)} /> : null}
    </Screen>
  );
};
