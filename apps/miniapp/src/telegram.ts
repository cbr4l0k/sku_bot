import type { ThemeParams, WebApp } from "@twa-dev/types";

declare global {
  interface Window {
    Telegram?: { WebApp: WebApp };
  }
}

const webApp = (): WebApp | null => (typeof window === "undefined" ? null : (window.Telegram?.WebApp ?? null));

/** True only when we are really running inside a Telegram client with signed init data. */
export const insideTelegram = (): boolean => {
  const app = webApp();
  return app !== null && app.initData.length > 0;
};

export const initData = (): string => webApp()?.initData ?? "";

export const startParam = (): string | null => webApp()?.initDataUnsafe.start_param ?? null;

export const telegramUser = () => webApp()?.initDataUnsafe.user ?? null;

export const colorScheme = (): "light" | "dark" => {
  const app = webApp();
  if (app) return app.colorScheme;
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
};

const applyScheme = () => {
  document.documentElement.dataset.scheme = colorScheme();
};

/**
 * Telegram itself writes --tg-theme-* custom properties onto the root element.
 * Outside Telegram nothing is written and the CSS fallbacks in index.css take over.
 */
export const initViewport = (onThemeChange?: () => void): (() => void) => {
  const app = webApp();
  applyScheme();
  if (!app) return () => {};
  app.ready();
  app.expand();
  const handler = () => {
    applyScheme();
    onThemeChange?.();
  };
  app.onEvent("themeChanged", handler);
  app.onEvent("viewportChanged", () => {
    document.documentElement.style.setProperty("--tg-viewport-height", `${app.viewportStableHeight}px`);
  });
  return () => app.offEvent("themeChanged", handler);
};

export const themeParams = (): Partial<ThemeParams> => webApp()?.themeParams ?? {};

/* ---------------------------------------------------------------- back button */

export const backButton = {
  show(onClick: () => void): () => void {
    const app = webApp();
    if (!app) return () => {};
    app.BackButton.onClick(onClick);
    app.BackButton.show();
    return () => {
      app.BackButton.offClick(onClick);
      app.BackButton.hide();
    };
  },
  hide(): void {
    webApp()?.BackButton.hide();
  },
};

/* -------------------------------------------------------------------- haptics */

type ImpactStyle = "light" | "medium" | "heavy" | "rigid" | "soft";

export const haptic = {
  tap(style: ImpactStyle = "light"): void {
    webApp()?.HapticFeedback.impactOccurred(style);
  },
  notify(type: "error" | "success" | "warning"): void {
    webApp()?.HapticFeedback.notificationOccurred(type);
  },
  select(): void {
    webApp()?.HapticFeedback.selectionChanged();
  },
};

/* --------------------------------------------------------------------- scanner */

export const canScan = (): boolean => {
  const app = webApp();
  return app !== null && app.isVersionAtLeast("6.4");
};

/** Resolves with the scanned text, or null when the user closed the scanner. */
export const scanQr = (text: string): Promise<string | null> =>
  new Promise((resolve) => {
    const app = webApp();
    if (!app) {
      resolve(null);
      return;
    }
    let settled = false;
    const closed = () => {
      if (settled) return;
      settled = true;
      app.offEvent("scanQrPopupClosed", closed);
      resolve(null);
    };
    app.onEvent("scanQrPopupClosed", closed);
    app.showScanQrPopup({ text }, (scanned) => {
      if (settled) return true;
      settled = true;
      app.offEvent("scanQrPopupClosed", closed);
      app.closeScanQrPopup();
      resolve(scanned);
      return true;
    });
  });

/* ------------------------------------------------------------------- clipboard */

export const copyText = async (value: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(field);
    return ok;
  }
};

export const openTelegramLink = (url: string): void => {
  const app = webApp();
  if (app) app.openTelegramLink(url);
  else window.open(url, "_blank", "noopener");
};
