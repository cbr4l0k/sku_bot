import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { CITIES } from "@sku/cities";

import { sku, type EventCard as EventCardData, type EventDetail } from "../api";
import { useI18n } from "../i18n";
import { countdown, errorText, fullDate, isPast } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource, useTicker } from "../lib/useResource";
import { haptic, openLink } from "../telegram";
import { CountdownRing, StatusBadge } from "../ui/event";
import { GroupChips } from "../ui/groups";
import { useConfirm, useToast } from "../ui/overlays";
import { Button, ErrorState, Loader, Screen, Track } from "../ui/primitives";

const OFFER_WINDOW_MS = 20 * 60 * 1000;

type Loaded = { detail: EventDetail; card: EventCardData | null };

export const EventDetailScreen = () => {
  const { t, locale } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  const [sweep, setSweep] = useState(false);
  useBackButton("/");

  const id = Number(params.id);

  const load = useCallback(async (): Promise<Loaded> => {
    const [detail, list] = await Promise.all([sku.event(id), sku.events().catch(() => [])]);
    return { detail, card: list.find((item) => item.id === id) ?? null };
  }, [id]);

  const resource = useResource(load, { pollMs: 20_000 });
  const now = useTicker(1000, resource.data?.card?.myPendingOffer != null);

  if (resource.loading && !resource.data) {
    return (
      <Screen>
        <Loader label={t("common.loading")} />
      </Screen>
    );
  }

  if (!resource.data) {
    return (
      <Screen>
        <ErrorState
          message={errorText(t, resource.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void resource.reload()}
        />
      </Screen>
    );
  }

  const { detail, card } = resource.data;
  const confirmed = card?.confirmedCount ?? 0;
  const left = detail.capacity === null ? null : Math.max(0, detail.capacity - confirmed);
  const offer = card?.myPendingOffer ?? null;
  const status = detail.myRegistrationStatus;
  // "Over" is an organizer's call, not the clock's: an event whose start time has
  // passed is still live — and still checkable-in — until someone ends it.
  const over = detail.endedAt !== null;
  const underway = !over && isPast(detail.startsAt);
  const joinable = detail.status === "published" && !over;

  const celebrate = () => {
    setSweep(true);
    window.setTimeout(() => setSweep(false), 800);
  };

  const join = () =>
    void action.run(
      async () => {
        const result = await sku.join(id);
        celebrate();
        if ("position" in result && result.status === "waitlisted") {
          toast(t("toast.waitlisted", { n: result.position }));
        } else {
          toast(t("toast.joined"));
        }
        await resource.reload(true);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const cancel = async () => {
    if (!(await confirm({ text: t("detail.confirmCancel"), confirmLabel: t("action.cancel"), danger: true }))) return;
    void action.run(
      async () => {
        await sku.cancel(id);
        toast(t("toast.canceled"));
        await resource.reload(true);
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
        celebrate();
        toast(t("offer.accepted"));
        await resource.reload(true);
      },
      {
        onError: (error) => {
          toast(errorText(t, error), "err");
          void resource.reload(true);
        },
      },
    );
  };

  const remaining = offer ? new Date(offer.expiresAt).getTime() - now : 0;

  return (
    <Screen>
      <div className="rise">
        <div className="mb-2 flex items-center gap-2.5">
          <span className="hairline min-w-4 flex-1" />
          <GroupChips groups={detail.groups} />
          <StatusBadge status={status} position={detail.myWaitlistPosition} hasOffer={offer !== null} />
        </div>
        <h1 className="hero mb-3 break-words">{detail.title}</h1>
      </div>

      {offer ? (
        <div
          className="rise card mb-4 border-transparent px-4 py-4"
          style={{ background: "var(--flare-soft)", borderColor: "color-mix(in oklab, var(--flare) 45%, transparent)", "--i": 1 } as React.CSSProperties}
        >
          <div className="flex items-center gap-3.5">
            <CountdownRing remaining={Math.max(0, remaining)} total={OFFER_WINDOW_MS} size={52}>
              <span className="num text-[9px]">{remaining > 0 ? "" : "!"}</span>
            </CountdownRing>
            <div className="min-w-0 flex-1">
              <h2 className="display text-[15px]">{t("offer.title")}</h2>
              <p className="mt-0.5 text-[12px] leading-snug text-hint">
                {remaining > 0 ? t("offer.body") : t("offer.expired")}
              </p>
            </div>
            <span className="num text-[17px] tabular-nums">{countdown(Math.max(0, remaining))}</span>
          </div>
          <Button
            block
            className="mt-3.5"
            sweep={sweep}
            loading={action.pending}
            onClick={accept}
          >
            {t("action.accept")}
          </Button>
        </div>
      ) : null}

      <section
        className="rise card mb-4 px-4 py-4"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <dl className="flex flex-col gap-3">
          <div>
            <dt className="eyebrow mb-0.5">{t("detail.when")}</dt>
            <dd className="text-[14px] first-letter:uppercase">{fullDate(detail.startsAt, locale)}</dd>
            {underway ? (
              <dd className="mt-1 text-[12px]" style={{ color: "var(--brand-deep)" }}>{t("detail.underway")}</dd>
            ) : null}
          </div>
          <div className="hairline" />
          <div>
            <dt className="eyebrow mb-0.5">{t("detail.where")}</dt>
            <dd className="min-w-0 text-[14px]">
              {detail.locationUrl ? (
                <button
                  type="button"
                  className="block max-w-full text-left break-words text-[color:var(--brand-deep)] underline decoration-current underline-offset-2"
                  aria-label={t("detail.openMap", { location: detail.location })}
                  onClick={() => {
                    if (!detail.locationUrl) return;
                    haptic.tap("light");
                    openLink(detail.locationUrl);
                  }}
                >
                  {detail.location}
                </button>
              ) : <span className="block break-words">{detail.location}</span>}
            </dd>
            <dd className="mt-1.5 flex items-center gap-2 text-[12px] text-hint">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: CITIES[detail.city].brandLift, boxShadow: `0 0 0 2px ${CITIES[detail.city].brand}` }}
              />
              {CITIES[detail.city].name[locale]}
            </dd>
          </div>
        </dl>

        <div className="mt-4">
          <Track
            value={confirmed}
            max={detail.capacity}
            label={
              detail.capacity === null
                ? t("events.freeEntry")
                : left === 0
                  ? t("events.full")
                  : t("events.spotsLeft", { n: left ?? 0 })
            }
            right={detail.capacity === null ? `${confirmed}` : `${confirmed}/${detail.capacity}`}
          />
        </div>
      </section>

      {detail.description ? (
        /* Prose belongs on paper: 14px in white would be 3.50:1 on the field,
           and 12.33:1 on a card. */
        <section className="rise card mb-5 px-4 py-4" style={{ "--i": 3 } as React.CSSProperties}>
          <div className="eyebrow mb-2">{t("detail.about")}</div>
          <p className="text-[14px] leading-relaxed whitespace-pre-line">{detail.description}</p>
        </section>
      ) : null}

      {status === "waitlisted" && detail.myWaitlistPosition ? (
        <p className="mb-4 text-[13px] leading-relaxed text-hint">{t("detail.waitlistHint")}</p>
      ) : null}
      {status === "registered" ? <p className="mb-4 text-[13px] text-hint">{t("detail.registeredHint")}</p> : null}
      {status === "checked_in" ? <p className="mb-4 text-[13px] text-hint">{t("detail.checkedInHint")}</p> : null}

      <div className="sticky bottom-[calc(6rem_+_env(safe-area-inset-bottom,0px))] flex flex-col gap-2">
        {!joinable ? (
          <div className="card px-4 py-3 text-center text-[13px] text-hint">
            {over ? t("detail.pastEvent") : detail.status === "canceled" ? t("detail.canceled") : t("detail.closed")}
          </div>
        ) : status === "registered" || status === "checked_in" ? (
          <>
            {status === "registered" ? (
              <Button block sweep={sweep} onClick={() => navigate("/checkin")}>
                {t("action.checkin")}
              </Button>
            ) : null}
            <Button variant="danger" block loading={action.pending} onClick={() => void cancel()}>
              {t("action.cancel")}
            </Button>
          </>
        ) : status === "waitlisted" ? (
          <>
            <div className="card flex items-center justify-between px-4 py-3">
              <span className="text-[13px]">{t("detail.waitlistPosition", { n: detail.myWaitlistPosition ?? 0 })}</span>
              <span className="display text-[20px]">№{detail.myWaitlistPosition ?? "—"}</span>
            </div>
            <Button variant="ghost" block loading={action.pending} onClick={() => void cancel()}>
              {t("action.cancel")}
            </Button>
          </>
        ) : left === 0 && !detail.waitlistEnabled ? (
          // No queue on this event: once the spots are gone, they are gone.
          <div className="card px-4 py-3 text-center text-[13px] text-hint">{t("detail.fullNoQueue")}</div>
        ) : (
          <Button
            block
            sweep={sweep}
            loading={action.pending}
            className={sweep ? "pulse-ring" : ""}
            onClick={join}
          >
            {left === 0 ? t("action.joinWaitlist") : t("action.join")}
          </Button>
        )}
      </div>
    </Screen>
  );
};
