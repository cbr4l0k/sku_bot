import { useCallback } from "react";
import { useParams } from "react-router";

import { sku } from "../api";
import { useI18n } from "../i18n";
import { errorText, fullName, relativeDayKey, shortDate, timeOf, untilStart } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useResource, useTicker } from "../lib/useResource";
import { useSession } from "../session";
import { QrCanvas } from "../ui/qr";
import { Chip, ErrorState, Loader, PageTitle, Screen, SectionRule } from "../ui/primitives";

/**
 * The runner's own ticket. It is polled rather than fetched once so that a
 * hoodie ticked off at the counter shows as collected on the runner's phone
 * without them doing anything — but the QR itself never changes, so a lost
 * signal at the door costs nothing.
 */
export const TicketScreen = () => {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const params = useParams();
  const id = Number(params.id);
  useBackButton(`/events/${id}`);
  const now = useTicker(30_000);

  const load = useCallback(async () => {
    const [ticket, event] = await Promise.all([sku.myTicket(id), sku.event(id)]);
    return { ticket, event };
  }, [id]);
  const resource = useResource(load, { pollMs: 30_000 });

  if (!resource.data) {
    return (
      <Screen>
        {resource.loading ? (
          <Loader label={t("common.loading")} />
        ) : (
          <ErrorState message={errorText(t, resource.error)} retryLabel={t("common.retry")} onRetry={() => void resource.reload()} />
        )}
      </Screen>
    );
  }

  const { ticket, event } = resource.data;
  const relative = relativeDayKey(event.startsAt);
  const msLeft = new Date(event.startsAt).getTime() - now;
  const day = relative ? t(relative) : shortDate(event.startsAt, locale);
  const eyebrow = msLeft > 0 && msLeft < 86_400_000
    ? t("ticket.startsIn", { day, time: untilStart(msLeft, (n) => t("events.days", { n })) })
    : `${day} · ${timeOf(event.startsAt, locale)}`;
  const owed = ticket.items.filter((item) => item.handedOverAt === null);

  return (
    <Screen>
      <div className="eyebrow mb-2.5">{eyebrow}</div>
      <PageTitle title={t("ticket.title")} />

      <section className="card rise flex flex-col items-center p-[22px] text-center">
        <QrCanvas value={ticket.token} size={Math.min(200, window.innerWidth - 140)} />
        {me ? <div className="display mt-4 text-[18px]">{fullName(me)}</div> : null}
        <div className="mt-0.5 text-[13px] text-hint">
          {event.title} · {timeOf(event.startsAt, locale)}
        </div>
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          <Chip>№ {String(ticket.number).padStart(4, "0")}</Chip>
          {ticket.ticketName ? <Chip tone="soft">{ticket.ticketName}</Chip> : null}
          {ticket.status === "checked_in" ? <Chip tone="flare">{t("ticket.checkedIn")}</Chip> : null}
        </div>
      </section>

      <SectionRule label={t("ticket.how")} />
      <section className="card rise" style={{ "--i": 1 } as React.CSSProperties}>
        <div className="row">
          <span className="num w-[22px] shrink-0">01</span>
          <span className="text-[14px]">{t("ticket.hint")}</span>
        </div>
        {owed.length > 0 ? (
          <div className="row">
            <span className="num w-[22px] shrink-0">02</span>
            <span className="text-[14px]">
              {t("ticket.collectAt")} <b>{owed.map((item) => `${item.name}${item.quantity > 1 ? ` × ${item.quantity}` : ""}`).join(", ")}</b>
            </span>
          </div>
        ) : null}
        {ticket.items.length > owed.length ? (
          <div className="row">
            <span className="num w-[22px] shrink-0">✓</span>
            <span className="text-[14px] text-hint">
              {t("ticket.collected")}: {ticket.items.filter((item) => item.handedOverAt !== null).map((item) => `${item.name}${item.quantity > 1 ? ` × ${item.quantity}` : ""}`).join(", ")}
            </span>
          </div>
        ) : null}
      </section>

      <p className="mx-1 mt-3.5 text-[12px] text-hint">{t("ticket.offline")}</p>
    </Screen>
  );
};
