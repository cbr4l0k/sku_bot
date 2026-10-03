import { createContext, use, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { useI18n, type MessageKey } from "../i18n";
import { useSession } from "../session";
import { haptic } from "../telegram";
import { Spinner } from "./primitives";

/**
 * The one action a screen offers, pinned where the tab bar sits. A screen that
 * declares one turns the tab bar into it; leaving the screen turns it back.
 */
export type DockAction = {
  label: string;
  onPress?: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** A state rather than a call to act ("On the waitlist · 3rd"): drawn quieter. */
  quiet?: boolean;
};

type Registered = DockAction & { press: () => void };

const DockContext = createContext<((action: Registered | null) => void) | null>(null);
const DockStateContext = createContext<Registered | null>(null);

export const DockProvider = ({ children }: { children: ReactNode }) => {
  const [action, setAction] = useState<Registered | null>(null);
  return (
    <DockContext value={setAction}>
      <DockStateContext value={action}>{children}</DockStateContext>
    </DockContext>
  );
};

/**
 * Declare this screen's action. Re-registers only when what is drawn changes;
 * the handler is read through a ref, so a fresh closure each render costs nothing.
 */
export const useDockAction = (action: DockAction | null): void => {
  const set = use(DockContext);
  if (!set) throw new Error("useDockAction must be used inside DockProvider");
  const press = useRef(action?.onPress);
  press.current = action?.onPress;
  const signature = action ? [action.label, action.loading, action.disabled, action.quiet, Boolean(action.onPress)].join("|") : null;

  useEffect(() => {
    set(action ? { ...action, press: () => press.current?.() } : null);
    // `signature` is the whole of what is drawn; the action object itself is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, signature]);

  useEffect(() => () => set(null), [set]);
};

const TABS: ReadonlyArray<{ to: string; key: MessageKey; glyph: string }> = [
  { to: "/", key: "nav.events", glyph: "◎" },
  { to: "/mine", key: "nav.mine", glyph: "▤" },
  { to: "/organizer", key: "nav.organizer", glyph: "⌁" },
  { to: "/admin", key: "nav.admin", glyph: "⌘" },
  { to: "/profile", key: "nav.profile", glyph: "◍" },
];

const ACTION_WIDTH = 300;
const ACTION_HEIGHT = 58;

export const Dock = () => {
  const { t } = useI18n();
  const { me } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const action = use(DockStateContext);
  const tabsRef = useRef<HTMLElement>(null);
  const [tabsSize, setTabsSize] = useState<{ width: number; height: number } | null>(null);

  const visible = TABS.filter((tab) => {
    if (tab.to === "/organizer") return Boolean(me?.isOrganizerOfAny || me?.isAdmin || me?.organizerCities.length);
    if (tab.to === "/admin") return Boolean(me?.isAdmin || me?.adminCities.length);
    return true;
  });
  const active = (to: string) => (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to));

  // The tab row is absolutely positioned inside the pill, so its natural size is
  // measured and handed to the pill — that is what lets the width transition run.
  useLayoutEffect(() => {
    const node = tabsRef.current;
    if (!node) return;
    const measure = () => setTabsSize({ width: node.offsetWidth, height: node.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const mode = action ? "action" : "tabs";
  // The border sits outside the measured row, so it is added back on.
  const size = action
    ? { width: ACTION_WIDTH, height: ACTION_HEIGHT }
    : tabsSize
      ? { width: tabsSize.width + 2, height: tabsSize.height + 2 }
      : undefined;

  return (
    <div className="dock" data-mode={mode} data-tone={action?.quiet ? "quiet" : undefined} style={size}>
      <nav ref={tabsRef} className="dock-tabs" aria-label={t("nav.sections")} aria-hidden={mode === "action"} inert={mode === "action"}>
        {visible.map((tab) => (
          <button
            key={tab.to}
            type="button"
            className="tab"
            data-active={active(tab.to)}
            onClick={() => {
              haptic.select();
              navigate(tab.to);
            }}
          >
            <span className="text-[13px] leading-none">{tab.glyph}</span>
            <span className="max-w-full truncate">{t(tab.key)}</span>
          </button>
        ))}
      </nav>
      <button
        type="button"
        className="dock-action"
        aria-hidden={mode === "tabs"}
        tabIndex={mode === "tabs" ? -1 : 0}
        disabled={!action?.onPress || action.disabled === true || action.loading === true}
        onClick={() => {
          haptic.tap("medium");
          action?.press();
        }}
      >
        {action ? (
          <span key={action.label} className="dock-label">
            {action.loading ? <Spinner /> : null}
            {action.label}
          </span>
        ) : null}
      </button>
    </div>
  );
};
