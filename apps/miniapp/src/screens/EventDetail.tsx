import { useCallback } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { CITIES } from "@sku/cities";

import { sku, type EventCard as EventCardData, type EventDetail } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { countdown, daysUntil, errorText, initials, isPast, longDay, money, ordinal, timeOf } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource, useTicker } from "../lib/useResource";
import { haptic, openLink } from "../telegram";
import { useDockAction, type DockAction } from "../ui/dock";
import { admission, CountdownRing, PriceChip, spotsLabel, spotsLeft, StatusBadge } from "../ui/event";
import { GroupChips } from "../ui/groups";
import { useConfirm, useToast } from "../ui/overlays";
import { Button, ErrorState, Loader, Screen, SectionRule, Track } from "../ui/primitives";
import { isTicketed } from "./Events";

const OFFER_WINDOW_MS = 20 * 60 * 1000;

type Loaded = { detail: EventDetail; card: EventCardData | null };

export const EventDetailScreen = () => {
  const { t } = useI18n();
  const params = useParams();
  useBackButton("/");
  const id = Number(params.id);

  const load = useCallback(async (): Promise<Loaded> => {
    const [detail, list] = await Promise.all([sku.event(id), sku.events().catch(() => [])]);
    return { detail, card: list.find((item) => item.id === id) ?? null };
  }, [id]);
  const resource = useResource(load, { pollMs: 20_000 });

  if (!resource.data) {
    return (
      <Screen>
        <PendingDock />
        {resource.loading ? (
          <Loader label={t("common.loading")} />
        ) : (
          <ErrorState message={errorText(t, resource.error)} retryLabel={t("common.retry")} onRetry={() => void resource.reload()} />
        )}
      </Screen>
    );
  }

  return <Loaded data={resource.data} reload={() => resource.reload(true)} />;
};

/** Holds the pill in its action shape while the event loads, so it morphs once, not twice. */
const PendingDock = () => {
  const { t } = useI18n();
  useDockAction({ label: t("common.loading"), loading: true, quiet: true });
  return null;
};

const Loaded = ({ data, reload }: { data: Loaded; reload: () => Promise<void> }) => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  const { detail, card } = data;
  const id = detail.id;
  const offer = card?.myPendingOffer ?? null;
  const now = useTicker(1000, offer !== null);

  const confirmed = card?.confirmedCount ?? 0;
  const left = spotsLeft(detail, confirmed);
  const status = detail.myRegistrationStatus;
  const holds = status === "registered" || status === "checked_in";
  // On the list by right of the job: they hold no spot, so there is no spot for
  // them to give back either.
  const staff = detail.myStaffEntry;
  // "Over" is an organizer's call, not the clock's: an event whose start time has
  // passed is still live — and still checkable-in — until someone ends it.
  const over = detail.endedAt !== null;
  const underway = !over && isPast(detail.startsAt);
  const joinable = detail.status === "published" && !over;
  const paidEvent = detail.ticketTiers.length > 0;
  const ticketed = isTicketed(detail);
  const price = admission(detail);
  // The bot's ticket buttons link here with the tier they named; checkout keeps it.
  const ticketParam = searchParams.get("ticket");
  const checkoutPath = `/events/${id}/checkout${ticketParam ? `?ticket=${encodeURIComponent(ticketParam)}` : ""}`;
  const merchOnSale = joinable && detail.products.some((product) => product.active);
  const remaining = offer ? new Date(offer.expiresAt).getTime() - now : 0;

  const join = () =>
    void action.run(
      async () => {
        const result = await sku.join(id);
        toast(t(result.status === "waitlisted" ? "toast.waitlisted" : "toast.joined"));
        await reload();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const cancel = async () => {
    if (!(await confirm({ text: t(paidEvent ? "detail.refundConfirm" : "detail.confirmCancel"), confirmLabel: t("action.cancel"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.cancel(id);
        toast(t(paidEvent ? "toast.refundStarted" : "toast.canceled"));
        await reload();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  const accept = () => {
    if (!offer) return;
    void action.run(
      async () => {
        await sku.acceptOffer(offer.id);
        haptic.notify("success");
        toast(t("offer.accepted"));
        await reload();
      },
      {
        onError: (error) => {
          toast(errorText(t, error), "err");
          void reload();
        },
      },
    );
  };

  // The one thing this screen asks of you, in the pill the tab bar becomes.
  const quiet = (key: MessageKey, params?: Record<string, string | number>): DockAction => ({ label: t(key, params), quiet: true });
  const dock: DockAction = !joinable
    ? quiet(over ? "detail.pastEvent" : detail.status === "canceled" ? "detail.canceled" : "detail.closed")
    : offer
      ? { label: t("action.accept"), onPress: accept, loading: action.pending }
      : holds
        ? ticketed
          ? { label: t("action.showTicket"), onPress: () => navigate(`/events/${id}/ticket`) }
          : status === "registered"
            ? { label: t("action.scan"), onPress: () => navigate("/checkin") }
            : quiet("status.checked_in")
        : paidEvent
          // A queue kept from before the event went paid still buys its way in.
          ? price.kind === "unavailable"
            ? quiet("detail.noTicketsAvailable")
            : { label: price.kind === "paid" ? t("detail.chooseTicketFrom", { price: money(price.from, locale) }) : t("detail.chooseTicket"), onPress: () => navigate(checkoutPath) }
          : status === "waitlisted"
            ? quiet("detail.queued", { place: ordinal(detail.myWaitlistPosition ?? 1, locale) })
            : left === 0 && !detail.waitlistEnabled
              ? quiet("detail.fullNoQueue")
              : { label: t(left === 0 ? "action.joinWaitlist" : "action.join"), onPress: join, loading: action.pending };
  useDockAction(dock);

  const days = daysUntil(detail.startsAt);
  const whenHint = underway
    ? t("detail.underway")
    : days > 1
      ? t("detail.inDays", { time: timeOf(detail.startsAt, locale), n: days })
      : timeOf(detail.startsAt, locale);
  const spotsHint: MessageKey | null = !joinable || holds
    ? null
    : left === 0
      ? detail.waitlistEnabled ? "detail.spotsFullQueue" : null
      : detail.waitlistEnabled ? "detail.spotsQueueHint" : null;
  const leaders = detail.organizers;

  return (
    <Screen className="pb-[calc(8rem_+_env(safe-area-inset-bottom,0px))]">
      <div className="rise mb-3.5 flex flex-wrap items-center gap-1.5">
        <PriceChip event={detail} tone="soft" />
        <StatusBadge status={status} hasOffer={offer !== null} />
        <GroupChips groups={detail.groups} />
      </div>
      <h1 className="hero rise mb-[22px] break-words">{detail.title}</h1>

      <section className="card rise" style={{ "--i": 1 } as React.CSSProperties}>
        <div className="row">
          <span className="eyebrow w-16 shrink-0">{t("detail.when")}</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold first-letter:uppercase">{longDay(detail.startsAt, locale)}</div>
            <div className="text-[13px] text-hint">{whenHint}</div>
          </div>
        </div>
        {detail.locationUrl ? (
          <button
            type="button"
            className="row"
            aria-label={t("detail.openMap", { location: detail.location })}
            onClick={() => {
              if (!detail.locationUrl) return;
              haptic.tap("light");
              openLink(detail.locationUrl);
            }}
          >
            <Where detail={detail} />
            <span className="chev">↗</span>
          </button>
        ) : (
          <div className="row">
            <Where detail={detail} />
          </div>
        )}
        <div className="row items-start">
          <span className="eyebrow w-16 shrink-0 pt-0.5">{t("detail.spots")}</span>
          <div className="min-w-0 flex-1">
            <Track
              value={confirmed}
              max={detail.capacity}
              label={spotsLabel(t, detail.capacity, left)}
              right={detail.capacity === null ? `${confirmed}` : `${confirmed}/${detail.capacity}`}
            />
            {spotsHint ? <p className="mt-2.5 text-[12px] text-hint">{t(spotsHint)}</p> : null}
          </div>
        </div>
        {leaders.length ? (
          <div className="row">
            <span className="eyebrow w-16 shrink-0">{t("detail.ledBy")}</span>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="flex shrink-0">
                {leaders.slice(0, 3).map((person, index) => (
                  <span key={person.id} className="av" style={index ? { marginLeft: -14, border: "2px solid var(--paper)" } : undefined}>
                    {initials(person)}
                  </span>
                ))}
              </span>
              <span className="min-w-0 truncate text-[13px]">{leaders.map((person) => person.firstName).join(", ")}</span>
            </div>
          </div>
        ) : null}
      </section>

      {offer ? (
        <section className="card rise mt-3 p-4" style={{ "--i": 2 } as React.CSSProperties}>
          <div className="flex items-center gap-3.5">
            <CountdownRing remaining={Math.max(0, remaining)} total={OFFER_WINDOW_MS} size={58}>
              <span className="num text-[12px]">{countdown(Math.max(0, remaining))}</span>
            </CountdownRing>
            <div className="min-w-0 flex-1">
              <h2 className="display text-[15px]">{t("offer.title")}</h2>
              <p className="mt-0.5 text-[12px] leading-snug text-hint">{remaining > 0 ? t("offer.body") : t("offer.expired")}</p>
            </div>
          </div>
        </section>
      ) : null}

      {detail.description ? (
        <>
          <SectionRule label={t("detail.about")} />
          {/* Prose belongs on paper: 14px in white would be 3.50:1 on the field,
              and 12.33:1 on a card. */}
          <section className="card rise p-4" style={{ "--i": 2 } as React.CSSProperties}>
            <p className="text-[14px] leading-[1.55] whitespace-pre-line">{detail.description}</p>
          </section>
        </>
      ) : null}

      {merchOnSale && (holds || !paidEvent) ? (
        <Link to={checkoutPath} className="card row rise mt-3" style={{ "--i": 3 } as React.CSSProperties}>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">{t("detail.extras")}</span>
            <span className="block text-[12px] text-hint">{t("detail.extrasHint")}</span>
          </span>
          <span className="chev">›</span>
        </Link>
      ) : null}

      {status === "waitlisted" && !offer ? <p className="mt-4 text-[13px] leading-relaxed text-hint">{t("detail.waitlistHint")}</p> : null}
      {staff ? <p className="mt-4 text-[13px] leading-relaxed text-hint">{t("detail.staffHint")}</p> : null}

      {joinable && (status === "waitlisted" || (holds && !staff)) ? (
        <Button variant="danger" size="sm" block className="mt-5" loading={action.pending} onClick={() => void cancel()}>
          {t(status === "waitlisted" ? "action.leaveQueue" : "action.cancel")}
        </Button>
      ) : null}
    </Screen>
  );
};

const Where = ({ detail }: { detail: EventDetail }) => {
  const { t, locale } = useI18n();
  return (
    <>
      <span className="eyebrow w-16 shrink-0">{t("detail.where")}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold break-words">{detail.location}</span>
        <span className="flex items-center gap-2 text-[13px] text-hint">
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: CITIES[detail.city].brandLift, boxShadow: `0 0 0 2px ${CITIES[detail.city].brand}` }}
          />
          {CITIES[detail.city].name[locale]}
        </span>
      </span>
    </>
  );
};
