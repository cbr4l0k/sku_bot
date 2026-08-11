import { useNavigate } from "react-router";

import { sku } from "../api";
import { useI18n } from "../i18n";
import { errorText } from "../lib/format";
import { useResource } from "../lib/useResource";
import { EventCard } from "../ui/event";
import { Button, EmptyState, ErrorState, Loader, PageTitle, Screen, SectionRule } from "../ui/primitives";

export const MineScreen = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const events = useResource(sku.events, { pollMs: 60_000 });

  const mine = (events.data ?? []).filter(
    (event) =>
      (event.myRegistrationStatus !== null && event.myRegistrationStatus !== "canceled") ||
      event.myPendingOffer !== null,
  );

  const checkedIn = mine.filter((event) => event.myRegistrationStatus === "checked_in");
  const ahead = mine.filter((event) => event.myRegistrationStatus !== "checked_in");

  return (
    <Screen>
      <PageTitle title={t("mine.title")} />

      {events.loading && !events.data ? <Loader label={t("common.loading")} /> : null}
      {events.error && !events.data ? (
        <ErrorState
          message={errorText(t, events.error)}
          retryLabel={t("common.retry")}
          onRetry={() => void events.reload()}
        />
      ) : null}

      {events.data && mine.length === 0 ? (
        <EmptyState
          text={t("mine.empty")}
          action={
            <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
              {t("mine.goToEvents")}
            </Button>
          }
        />
      ) : null}

      {ahead.length > 0 ? (
        <>
          <SectionRule label={t("mine.upcoming")} />
          <div className="flex flex-col gap-3">
            {ahead.map((event, index) => (
              <EventCard key={event.id} event={event} index={index} />
            ))}
          </div>
        </>
      ) : null}

      {checkedIn.length > 0 ? (
        <>
          <SectionRule label={t("status.checked_in")} />
          <div className="flex flex-col gap-3">
            {checkedIn.map((event, index) => (
              <EventCard key={event.id} event={event} index={index} />
            ))}
          </div>
        </>
      ) : null}
    </Screen>
  );
};
