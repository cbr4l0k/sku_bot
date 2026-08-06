import { createContext, use, type ReactNode } from "react";

import type { Me } from "./api";

type SessionValue = {
  me: Me | null;
  reload: () => void;
  /** True when we have a signed Telegram session; false in a plain browser. */
  live: boolean;
};

const SessionContext = createContext<SessionValue | null>(null);

export const SessionProvider = ({ value, children }: { value: SessionValue; children: ReactNode }) => (
  <SessionContext value={value}>{children}</SessionContext>
);

export const useSession = (): SessionValue => {
  const value = use(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
};
