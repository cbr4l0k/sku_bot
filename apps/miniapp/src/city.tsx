import { createContext, use, useEffect, type ReactNode } from "react";

import { CITIES, DEFAULT_CITY, type City, type CitySlug } from "@sku/cities";

/**
 * The branch the app is currently wearing.
 *
 * Colour is not passed down the tree: the provider writes the branch's three
 * hexes onto the root element and every rule in index.css mixes its own rung out
 * of them. That keeps the palette one system rather than a prop threaded through
 * a hundred components, and means a branch is two files — this and @sku/cities.
 */

const CityContext = createContext<City | null>(null);

/** Telegram paints its own chrome from this, so it has to follow the branch too. */
const setThemeColor = (color: string) => {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", color);
};

export const CityProvider = ({ city, children }: { city: CitySlug | null; children: ReactNode }) => {
  // Someone who has not chosen yet still has to look at *something* while they
  // choose, and the club's own colour is the honest default.
  const active = CITIES[city ?? DEFAULT_CITY];

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--brand", active.brand);
    root.style.setProperty("--brand-lift", active.brandLift);
    root.style.setProperty("--swoosh", active.swoosh);
    root.dataset.fieldInk = active.fieldInk;
    root.dataset.city = active.slug;
    setThemeColor(active.brand);
  }, [active]);

  return <CityContext value={active}>{children}</CityContext>;
};

export const useCity = (): City => {
  const value = use(CityContext);
  if (!value) throw new Error("useCity must be used inside CityProvider");
  return value;
};
