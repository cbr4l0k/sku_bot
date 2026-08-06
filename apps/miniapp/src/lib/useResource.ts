import { useCallback, useEffect, useRef, useState } from "react";

type State<T> = { data: T | null; error: Error | null; loading: boolean };

type Options = {
  /** Refetch every N ms while the tab is visible. */
  pollMs?: number;
  /** Skip fetching entirely (e.g. route not reachable for this user). */
  enabled?: boolean;
};

/**
 * Small fetch-state hook: loads on mount, refetches when the app regains focus
 * (Telegram keeps the webview alive between opens) and optionally polls.
 */
export const useResource = <T>(fetcher: () => Promise<T>, options: Options = {}) => {
  const { pollMs, enabled = true } = options;
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: enabled });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const alive = useRef(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState((prev) => ({ ...prev, loading: true }));
    try {
      const data = await fetcherRef.current();
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (cause) {
      if (alive.current) {
        setState((prev) => ({
          data: prev.data,
          error: cause instanceof Error ? cause : new Error("request_failed"),
          loading: false,
        }));
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return () => {
        alive.current = false;
      };
    }
    void load();
    const onFocus = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    const timer = pollMs ? window.setInterval(() => void load(true), pollMs) : undefined;
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pollMs, load]);

  const mutate = useCallback((updater: (current: T) => T) => {
    setState((prev) => (prev.data === null ? prev : { ...prev, data: updater(prev.data) }));
  }, []);

  return { ...state, reload: load, mutate };
};

/** Wraps a mutating call: tracks pending state and swallows nothing. */
export const useAction = () => {
  const [pending, setPending] = useState(false);
  const run = useCallback(async <R>(task: () => Promise<R>, handlers: { onError?: (error: Error) => void } = {}) => {
    setPending(true);
    try {
      return await task();
    } catch (cause) {
      handlers.onError?.(cause instanceof Error ? cause : new Error("request_failed"));
      return null;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, run };
};

/** Re-renders every `ms` — used by countdowns and the QR refresh ring. */
export const useTicker = (ms: number, enabled = true): number => {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setTick(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms, enabled]);
  return tick;
};
