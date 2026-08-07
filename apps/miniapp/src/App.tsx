import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";

import { onBlocked, sku, type Locale } from "./api";
import { I18nProvider, useI18n } from "./i18n";
import { useResource } from "./lib/useResource";
import { AdminScreen } from "./screens/Admin";
import { AdminEventScreen } from "./screens/AdminEvent";
import { CheckinScreen } from "./screens/Checkin";
import { EventDetailScreen } from "./screens/EventDetail";
import { EventsScreen } from "./screens/Events";
import { MineScreen } from "./screens/Mine";
import { OrganizerScreen } from "./screens/Organizer";
import { OrganizerEventScreen } from "./screens/OrganizerEvent";
import { ProfileScreen } from "./screens/Profile";
import { SessionProvider, useSession } from "./session";
import { initViewport, insideTelegram, startParam } from "./telegram";
import { ConfirmProvider, ToastProvider } from "./ui/overlays";
import { Spinner } from "./ui/primitives";
import { Backdrop, SwooshMark } from "./ui/swoosh";

/* ------------------------------------------------------------------ tab bar */

const TABS = [
  { to: "/", key: "nav.events", glyph: "◎" },
  { to: "/mine", key: "nav.mine", glyph: "▤" },
  { to: "/organizer", key: "nav.organizer", glyph: "⌁" },
  { to: "/admin", key: "nav.admin", glyph: "⌘" },
  { to: "/profile", key: "nav.profile", glyph: "◍" },
] as const;

const TabBar = () => {
  const { t } = useI18n();
  const { me } = useSession();
  const location = useLocation();
  const navigate = useNavigate();

  const visible = TABS.filter((tab) => {
    if (tab.to === "/organizer") return Boolean(me?.isOrganizerOfAny || me?.isAdmin);
    if (tab.to === "/admin") return Boolean(me?.isAdmin);
    return true;
  });

  const active = (to: string) => (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to));

  return (
    <nav className="tabbar">
      {visible.map((tab) => (
        <button
          key={tab.to}
          type="button"
          className="tab"
          data-active={active(tab.to)}
          onClick={() => navigate(tab.to)}
        >
          <span className="text-[13px] leading-none">{tab.glyph}</span>
          <span className="max-w-full truncate">{t(tab.key)}</span>
        </button>
      ))}
    </nav>
  );
};

/* ------------------------------------------------------------- start_param */

const StartParamRedirect = () => {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const param = startParam();
    const match = param?.match(/^evt_(\d+)$/);
    if (match?.[1] && location.pathname === "/") navigate(`/events/${match[1]}`, { replace: true });
    // Runs once on boot: the launch parameter never changes within a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
};

/* ---------------------------------------------------------------- gate views */

const BlockedScreen = ({ reason }: { reason: "banned" | "unauthorized" }) => {
  const { t } = useI18n();
  return (
    <div className="relative z-10 mx-auto flex min-h-full max-w-[460px] flex-col items-center justify-center px-7 text-center">
      <SwooshMark className="mb-6 h-14 w-14" />
      <h1 className="hero mb-3">{t("app.blocked.title")}</h1>
      <p className="text-[14px] leading-relaxed text-hint">
        {reason === "banned" ? t("app.blocked.banned") : t("app.blocked.unauthorized")}
      </p>
    </div>
  );
};

const OutsideBanner = () => {
  const { t } = useI18n();
  return (
    <div className="relative z-20 mx-auto max-w-[560px] px-4 pt-3">
      <div className="card flex items-center gap-2.5 rounded-xl px-3.5 py-2.5">
        <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--flare)" }} />
        <span className="text-[12px] leading-snug text-hint">{t("app.outsideTelegram")}</span>
      </div>
    </div>
  );
};

/* ---------------------------------------------------------------- app shell */

const Shell = () => (
  <>
    <StartParamRedirect />
    {insideTelegram() ? null : <OutsideBanner />}
    <Routes>
      <Route path="/" element={<EventsScreen />} />
      <Route path="/events/:id" element={<EventDetailScreen />} />
      <Route path="/mine" element={<MineScreen />} />
      <Route path="/checkin" element={<CheckinScreen />} />
      <Route path="/profile" element={<ProfileScreen />} />
      <Route path="/organizer" element={<OrganizerScreen />} />
      <Route path="/organizer/events/:id" element={<OrganizerEventScreen />} />
      <Route path="/admin" element={<AdminScreen />} />
      <Route path="/admin/events/:id" element={<AdminEventScreen />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    <TabBar />
  </>
);

const Boot = () => {
  const [blocked, setBlocked] = useState<"banned" | "unauthorized" | null>(null);
  const [locale, setLocaleState] = useState<Locale>("ru");
  const session = useResource(sku.me, { enabled: insideTelegram() });
  const { data: me, reload } = session;

  useEffect(() => initViewport(), []);

  useEffect(
    () =>
      onBlocked((reason) => {
        // Outside Telegram there is no init data at all — that is a dev browser,
        // not a blocked user, so the UI stays browsable instead of being gated.
        if (reason === "unauthorized" && !insideTelegram()) return;
        setBlocked(reason);
      }),
    [],
  );

  useEffect(() => {
    if (me) setLocaleState(me.locale);
  }, [me]);

  const changeLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      void sku
        .setMe({ locale: next })
        .then(() => reload(true))
        .catch(() => undefined);
    },
    [reload],
  );

  if (insideTelegram() && !me && session.loading) {
    return (
      <div className="relative z-10 grid min-h-full place-items-center text-hint">
        <Spinner size={26} />
      </div>
    );
  }

  const reloadSession = () => void reload(true);

  return (
    <I18nProvider locale={locale} onLocaleChange={changeLocale}>
      <ToastProvider>
        <ConfirmProvider>
          <SessionProvider value={{ me, reload: reloadSession, live: insideTelegram() }}>
            {blocked ? <BlockedScreen reason={blocked} /> : <Shell />}
          </SessionProvider>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  );
};

export const App = () => (
  <BrowserRouter>
    {/* Sits behind every route, the boot spinner and the blocked screen alike:
        the field's swoosh is the page, not a per-screen decoration. */}
    <Backdrop />
    <Boot />
  </BrowserRouter>
);
