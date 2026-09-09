import { useCallback } from "react";
import { useParams } from "react-router";

import { sku } from "../api";
import { useI18n } from "../i18n";
import { errorText } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useResource } from "../lib/useResource";
import { QrCanvas } from "../ui/qr";
import { Chip, ErrorState, Loader, PageTitle, Screen } from "../ui/primitives";

/**
 * The runner's own ticket. It is polled rather than fetched once so that a
 * hoodie ticked off at the counter shows as collected on the runner's phone
 * without them doing anything — but the QR itself never changes, so a lost
 * signal at the door costs nothing.
 */
export const TicketScreen = () => {
  const { t } = useI18n();
  const params = useParams();
  const id = Number(params.id);
  useBackButton(`/events/${id}`);

  const ticket = useResource(useCallback(() => sku.myTicket(id), [id]), { pollMs: 30_000 });

  if (ticket.loading && !ticket.data) {
    return (
      <Screen>
        <Loader label={t("common.loading")} />
      </Screen>
    );
  }

  if (!ticket.data) {
    return (
      <Screen>
        <ErrorState
          message={errorText(t, ticket.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void ticket.reload()}
        />
      </Screen>
    );
  }

  const { token, status, ticketName, items } = ticket.data;

  return (
    <Screen>
      <PageTitle
        title={t("ticket.title")}
        aside={status === "checked_in" ? <Chip tone="flare">{t("ticket.checkedIn")}</Chip> : null}
      />

      <section className="rise card flex flex-col items-center px-4 py-6">
        <QrCanvas value={token} size={Math.min(252, window.innerWidth - 112)} />
        {ticketName ? (
          <Chip tone="soft" className="mt-4">
            {ticketName}
          </Chip>
        ) : null}
        <p className="mt-4 max-w-[280px] text-center text-[13px] leading-relaxed text-hint">{t("ticket.hint")}</p>
      </section>

      {items.length > 0 ? (
        <section className="rise card mt-3 px-4 py-4" style={{ "--i": 1 } as React.CSSProperties}>
          <div className="eyebrow mb-2">{t("ticket.collect")}</div>
          <div className="flex flex-col">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 border-b border-hair py-2 text-[13px] last:border-b-0"
              >
                <span className="min-w-0 break-words">
                  {item.name}
                  {item.quantity > 1 ? ` × ${item.quantity}` : ""}
                </span>
                {item.handedOverAt ? <Chip tone="soft">{t("ticket.collected")}</Chip> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <p className="mt-3 text-center text-[12px] leading-relaxed text-hint">{t("ticket.offline")}</p>
    </Screen>
  );
};
