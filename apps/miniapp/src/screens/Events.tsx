import { useNavigate } from "react-router";

import { sku } from "../api";
import { useI18n } from "../i18n";
import { errorText } from "../lib/format";
import { useResource } from "../lib/useResource";
import { EventCard } from "../ui/event";
import { EmptyState, ErrorState, Loader, PageTitle, Screen } from "../ui/primitives";

export const EventsScreen = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const events = useResource(sku.events, { pollMs: 45_000 });

  const canScanSomething = (events.data ?? []).some(
    (event) => event.myRegistrationStatus === "registered" || event.myRegistrationStatus === "checked_in",
  );

  return (
    <Screen>
      <PageTitle
        eyebrow={`${t("app.name")} · ${t("app.tagline")}`}
        title={t("events.title")}
        aside={
          canScanSomething ? (
            <button
              type="button"
              onClick={() => navigate("/checkin")}
              className="chip chip-soft active:scale-95"
              style={{ transition: "transform 0.12s" }}
            >
              ⌗ {t("action.checkin")}
            </button>
          ) : null
        }
      />

      <p className="mb-5 max-w-[85%] text-[13px] leading-relaxed text-hint">{t("events.subtitle")}</p>

      {events.loading && !events.data ? <Loader label={t("common.loading")} /> : null}

      {events.error && !events.data ? (
        <ErrorState
          message={errorText(t, events.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void events.reload()}
        />
      ) : null}

      {events.data ? (
        events.data.length === 0 ? (
          <EmptyState text={t("events.empty")} />
        ) : (
          <div className="flex flex-col gap-3">
            {events.data.map((event, index) => (
              <EventCard key={event.id} event={event} index={index} />
            ))}
          </div>
        )
      ) : null}
    </Screen>
  );
};
