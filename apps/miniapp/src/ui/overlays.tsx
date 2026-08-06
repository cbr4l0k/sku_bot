import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { useI18n } from "../i18n";
import { haptic } from "../telegram";
import { Button } from "./primitives";

/* --------------------------------------------------------------------- toast */

type Tone = "ok" | "err";
type ToastState = { id: number; text: string; tone: Tone };

const ToastContext = createContext<((text: string, tone?: Tone) => void) | null>(null);

export const useToast = () => {
  const value = use(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const push = useCallback((text: string, tone: Tone = "ok") => {
    setToast({ id: Date.now(), text, tone });
    haptic.notify(tone === "ok" ? "success" : "error");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  return (
    <ToastContext value={push}>
      {children}
      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
          <div
            key={toast.id}
            style={{ animation: "toastIn 0.3s var(--ease-out-back)" }}
            className="flex max-w-[92%] items-center gap-2.5 rounded-full border border-hair bg-surface/95 px-4 py-2.5 shadow-[0_16px_44px_-20px_rgb(0_0_0/0.7)] backdrop-blur-md"
          >
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: toast.tone === "ok" ? "var(--flare)" : "var(--color-danger)" }}
            />
            <span className="text-[13px] leading-snug">{toast.text}</span>
          </div>
        </div>
      ) : null}
    </ToastContext>
  );
};

/* ------------------------------------------------------------------- confirm */

type ConfirmRequest = { text: string; confirmLabel?: string; danger?: boolean };
type Pending = ConfirmRequest & { resolve: (value: boolean) => void };

const ConfirmContext = createContext<((request: ConfirmRequest) => Promise<boolean>) | null>(null);

export const useConfirm = () => {
  const value = use(ConfirmContext);
  if (!value) throw new Error("useConfirm must be used inside ConfirmProvider");
  return value;
};

export const ConfirmProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useI18n();
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        haptic.tap("soft");
        setPending({ ...request, resolve });
      }),
    [],
  );

  const settle = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };

  const value = useMemo(() => ask, [ask]);

  return (
    <ConfirmContext value={value}>
      {children}
      {pending ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => settle(false)}
            className="fade-in absolute inset-0 bg-black/45 backdrop-blur-[2px]"
          />
          <div className="sheet-in relative m-3 w-full max-w-[460px] rounded-[22px] border border-hair bg-surface p-5 shadow-[0_30px_70px_-30px_rgb(0_0_0/0.8)]">
            <div className="checker mb-4 w-14" />
            <p className="mb-5 text-[15px] leading-relaxed">{pending.text}</p>
            <div className="flex gap-2">
              <Button variant="ghost" block onClick={() => settle(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant={pending.danger ? "danger" : "primary"} block onClick={() => settle(true)}>
                {pending.confirmLabel ?? t("common.confirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext>
  );
};

/* --------------------------------------------------------------------- sheet */

export const Sheet = ({
  title,
  onClose,
  children,
  full = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  full?: boolean;
}) => {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={onClose}
        className="fade-in absolute inset-0 bg-black/50 backdrop-blur-[2px]"
      />
      <div
        className={`sheet-in relative flex w-full max-w-[560px] flex-col overflow-hidden rounded-t-[24px] border border-hair bg-surface ${
          full ? "h-[94dvh]" : "max-h-[88dvh]"
        }`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-hair px-5 py-4">
          <h2 className="display text-[16px]">{title}</h2>
          <button type="button" onClick={onClose} className="eyebrow px-1 py-1" aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>
  );
};
