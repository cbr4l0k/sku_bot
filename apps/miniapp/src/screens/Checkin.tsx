import { useState } from "react";
import { useNavigate } from "react-router";

import { sku, type ScannedTicket } from "../api";
import { useI18n } from "../i18n";
import { errorText } from "../lib/format";
import { useAction } from "../lib/useResource";
import { useBackButton } from "../lib/useBackButton";
import { canScan, haptic, scanQr } from "../telegram";
import { useToast } from "../ui/overlays";
import { ScanDialog } from "../ui/roster";
import { SuccessBurst } from "../ui/qr";
import { Button, PageTitle, Screen } from "../ui/primitives";

/**
 * The runner's scan, straight from the button that asks for it: the camera opens
 * at once, and the outcome comes back as a toast instead of a screen of its own.
 */
export const useCheckinScan = (onDone: () => Promise<unknown> | void) => {
  const { t } = useI18n();
  const toast = useToast();
  const action = useAction();
  const scan = () => {
    if (!canScan()) {
      toast(t("checkin.unavailable"), "err");
      return;
    }
    void action.run(
      async () => {
        const code = await scanQr(t("checkin.scanText"));
        if (code === null) return;
        await sku.checkin(code.trim());
        haptic.notify("success");
        toast(`${t("checkin.success")} · ${t("checkin.successHint")}`);
        await onDone();
      },
      {
        onError: (error) => {
          haptic.notify("error");
          toast(errorText(t, error), "err");
        },
      },
    );
  };
  return { scan, pending: action.pending };
};

/** Staff's side of the same door: they hold the QR up, so they turn in instead of scanning it. */
export const useTurnIn = (eventId: number, onDone: () => Promise<unknown> | void) => {
  const { t } = useI18n();
  const toast = useToast();
  const action = useAction();
  const turnIn = () =>
    void action.run(
      async () => {
        await sku.turnIn(eventId);
        haptic.notify("success");
        toast(t("toast.turnedIn"));
        await onDone();
      },
      {
        onError: (error) => {
          haptic.notify("error");
          toast(errorText(t, error), "err");
        },
      },
    );
  return { turnIn, pending: action.pending };
};

/**
 * Staff at a paid run's door: the same scan the organizer screen has, with the
 * ticket kept up afterwards so the merch can be handed over from it.
 */
export const useTicketScan = (eventId: number, onDone: () => Promise<unknown> | void) => {
  const { t } = useI18n();
  const toast = useToast();
  const action = useAction();
  const [scanned, setScanned] = useState<ScannedTicket | null>(null);
  const [busyItem, setBusyItem] = useState<number | null>(null);
  const fail = (error: unknown) => {
    haptic.notify("error");
    toast(errorText(t, error), "err");
  };
  const scan = () => {
    if (!canScan()) {
      toast(t("checkin.unavailable"), "err");
      return;
    }
    void action.run(
      async () => {
        setScanned(null);
        const code = await scanQr(t("organizer.scanText"));
        if (code === null) return;
        const result = await sku.scanTicket(eventId, code.trim());
        haptic.notify(result.alreadyCheckedIn ? "warning" : "success");
        setScanned(result);
        await onDone();
      },
      { onError: fail },
    );
  };
  const handover = (itemId: number) => {
    setBusyItem(itemId);
    void action
      .run(
        async () => {
          const result = await sku.toggleHandover(eventId, itemId);
          haptic.tap(result.handedOverAt ? "medium" : "light");
          setScanned((current) =>
            current ? { ...current, items: current.items.map((item) => (item.id === itemId ? { ...item, handedOverAt: result.handedOverAt } : item)) } : null,
          );
        },
        { onError: fail },
      )
      .finally(() => setBusyItem(null));
  };
  const dialog = scanned ? (
    <ScanDialog
      scanned={scanned}
      position={null}
      pending={action.pending}
      busyItem={busyItem}
      onHandover={handover}
      onNext={scan}
      onClose={() => setScanned(null)}
    />
  ) : null;
  return { scan, pending: action.pending, dialog };
};

type Outcome = { kind: "ok" } | { kind: "err"; message: string } | null;

export const CheckinScreen = () => {
  const { t } = useI18n();
  const action = useAction();
  const navigate = useNavigate();
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
      <PageTitle title={t("checkin.title")} />

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
            <p className="mb-4 max-w-[280px] text-[13px]" style={{ color: "var(--danger)" }}>
              {outcome.message}
            </p>
          ) : null}
          <Button block loading={action.pending} disabled={!canScan()} onClick={scan}>
            {outcome?.kind === "err" ? t("checkin.tryAgain") : t("action.scan")}
          </Button>
        </div>
      )}

      {/* Once you are checked in another scan is meaningless, so the only useful
          action left is going back to the events list. */}
      {outcome?.kind === "ok" ? (
        <Button variant="ghost" block className="mt-3" onClick={() => navigate("/")}>
          {t("common.back")}
        </Button>
      ) : null}
    </Screen>
  );
};
