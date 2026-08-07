import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";

import { SwooshMark } from "./swoosh";

/**
 * QR is rendered client-side (no network, no external service) on a fixed
 * white plate — scanners need the contrast even when the app is in dark mode.
 */
export const QrCanvas = ({ value, size = 260 }: { value: string; size?: number }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    QRCode.toCanvas(target, value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: "M",
      // Brand's deepest teal rather than black — still ~17:1 on white, which is
      // far more than any scanner needs.
      color: { dark: "#022024", light: "#ffffff" },
    })
      .then(() => setFailed(false))
      .catch(() => setFailed(true));
  }, [value, size]);

  return (
    <div className="relative" style={{ width: size + 28, height: size + 28 }}>
      <div className="absolute inset-0 rounded-[20px] bg-white" />
      {(["top-2 left-2 border-t-2 border-l-2", "top-2 right-2 border-t-2 border-r-2", "bottom-2 left-2 border-b-2 border-l-2", "bottom-2 right-2 border-b-2 border-r-2"] as const).map(
        (corner) => (
          <span
            key={corner}
            /* --flare is white; on the white plate the marks have to be the
               ink side of the pair instead. */
            className={`absolute h-5 w-5 rounded-[3px] ${corner}`}
            style={{ borderColor: "var(--flare-ink)" }}
          />
        ),
      )}
      <canvas ref={canvas} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      {failed ? (
        <span className="absolute inset-0 grid place-items-center text-[12px] text-black">QR</span>
      ) : null}
    </div>
  );
};

/** Success moment: expanding rings out of a white disc + a drawn check mark. */
export const SuccessBurst = ({ label, hint }: { label: string; hint?: string }) => (
  <div className="flex flex-col items-center py-8 text-center">
    <div className="relative mb-5 grid h-24 w-24 place-items-center">
      {[0, 1].map((ring) => (
        <span
          key={ring}
          className="absolute inset-0 rounded-full"
          style={{
            border: "2px solid var(--flare)",
            animation: `ripple 1.1s ease-out ${ring * 0.22}s both`,
          }}
        />
      ))}
      <span className="grid h-20 w-20 place-items-center rounded-full" style={{ background: "var(--flare)" }}>
        <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden>
          <path
            d="M9 20.5 16 27l13-15"
            fill="none"
            stroke="var(--flare-ink)"
            strokeWidth="3.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="60"
            style={{ animation: "drawCheck 0.5s ease-out 0.12s both" }}
          />
        </svg>
      </span>
    </div>
    <h3 className="display text-[20px]">{label}</h3>
    {hint ? <p className="mt-2 text-[13px] text-hint">{hint}</p> : null}
    <SwooshMark className="mt-5 h-9 w-9" />
  </div>
);
