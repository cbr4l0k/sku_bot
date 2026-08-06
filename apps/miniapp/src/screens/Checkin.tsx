import { useState } from "react";

import { sku } from "../api";
import { useI18n } from "../i18n";
import { errorText } from "../lib/format";
import { useAction } from "../lib/useResource";
import { useBackButton } from "../lib/useBackButton";
import { canScan, haptic, scanQr } from "../telegram";
import { SuccessBurst } from "../ui/qr";
import { Button, PageTitle, Screen } from "../ui/primitives";

type Outcome = { kind: "ok" } | { kind: "err"; message: string } | null;

export const CheckinScreen = () => {
  const { t } = useI18n();
  const action = useAction();
  const [outcome, setOutcome] = useState<Outcome>(null);
  useBackButton("/");

  const scan = () =>
    void action.run(async () => {
      setOutcome(null);
      const code = await scanQr(t("checkin.scanText"));
      if (code === null) return;
      try {
        await sku.checkin(code.trim());
        haptic.notify("success");
        setOutcome({ kind: "ok" });
      } catch (error) {
        haptic.notify("error");
        setOutcome({ kind: "err", message: errorText(t, error) });
      }
    });

  return (
    <Screen>
      <PageTitle eyebrow={t("app.name")} title={t("checkin.title")} />

      {outcome?.kind === "ok" ? (
        <div className="card px-4 py-2">
          <SuccessBurst label={t("checkin.success")} hint={t("checkin.successHint")} />
        </div>
      ) : (
        <div className="card rise flex flex-col items-center px-6 py-10 text-center">
          <div className="relative mb-6 grid h-40 w-40 place-items-center">
            <span className="absolute inset-0 rounded-[26px] border border-hair" />
            {(
              [
                "top-0 left-0 border-t-2 border-l-2 rounded-tl-[26px]",
                "top-0 right-0 border-t-2 border-r-2 rounded-tr-[26px]",
                "bottom-0 left-0 border-b-2 border-l-2 rounded-bl-[26px]",
                "bottom-0 right-0 border-b-2 border-r-2 rounded-br-[26px]",
              ] as const
            ).map((corner) => (
              <span
                key={corner}
                className={`absolute h-9 w-9 ${corner}`}
                style={{ borderColor: "var(--flare)" }}
              />
            ))}
            <svg width="66" height="66" viewBox="0 0 24 24" aria-hidden className="opacity-80">
              <path
                d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
              <path d="M3.5 12h17" stroke="var(--flare)" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </div>
          <p className="mb-6 max-w-[260px] text-[13px] leading-relaxed text-hint">
            {canScan() ? t("checkin.hint") : t("checkin.unavailable")}
          </p>
          {outcome?.kind === "err" ? (
            <p className="mb-4 max-w-[280px] text-[13px]" style={{ color: "var(--color-danger)" }}>
              {outcome.message}
            </p>
          ) : null}
          <Button block loading={action.pending} disabled={!canScan()} onClick={scan}>
            {outcome?.kind === "err" ? t("checkin.tryAgain") : t("action.scan")}
          </Button>
        </div>
      )}

      {outcome?.kind === "ok" ? (
        <Button variant="ghost" block className="mt-3" onClick={() => setOutcome(null)}>
          {t("checkin.tryAgain")}
        </Button>
      ) : null}
    </Screen>
  );
};
