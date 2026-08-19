/**
 * The club's branches. This is code rather than a table because a branch is not
 * data the club edits — it opens maybe once a year, and its colours ship with the
 * build that knows how to draw them.
 *
 * Lives in its own package because all three of `@sku/db` (for the column type),
 * the server and the mini app need it. Putting it in `@sku/db` would drag drizzle
 * and `bun:sqlite` into the browser bundle.
 */

export const cities = ["spb", "msk", "kzn"] as const;
export type CitySlug = (typeof cities)[number];

/**
 * A hold on one branch. `admin` runs the branch outright; `organizer` may raise
 * events in it and then run the ones they are on. Neither reaches another branch,
 * and both sit under `users.is_admin`, which still means the whole club.
 */
export const cityRoles = ["admin", "organizer"] as const;
export type CityRole = (typeof cityRoles)[number];

export type City = {
  slug: CitySlug;
  /**
   * Every branch is UTC+3 today — Tatarstan keeps Moscow time — so this changes
   * nothing yet. It exists so the fourth branch does not have to be the one that
   * discovers the bot formats every date in `Europe/Moscow`.
   */
  timezone: string;
  name: { ru: string; en: string };
  /** The field: the colour the whole app sits on. */
  brand: string;
  /** The logo mark's second colour, exactly as the branch uses it. */
  brandLift: string;
  /**
   * The decorative backdrop wash. Petersburg's is the logo colour; the others are
   * lifted off it so the shape stays as visible against red and green as it is
   * against teal (~1.35:1). The logo colours themselves are too close to their own
   * field to read as a shape — #27cb6c on #03c452 is 1.09:1, effectively invisible.
   */
  swoosh: string;
  /**
   * Whether white or near-black type carries on `brand`. Green is a light colour:
   * white on #03c452 is 2.33:1 and fails outright, where white on teal is 3.50:1
   * and on red 3.85:1. Kazan therefore flips the whole field context to dark ink.
   */
  fieldInk: "light" | "dark";
};

export const CITIES: Record<CitySlug, City> = {
  spb: {
    slug: "spb",
    timezone: "Europe/Moscow",
    name: { ru: "Санкт-Петербург", en: "Saint Petersburg" },
    brand: "#0097a8",
    brandLift: "#3eafbd",
    swoosh: "#3eafbd",
    fieldInk: "light",
  },
  msk: {
    slug: "msk",
    timezone: "Europe/Moscow",
    name: { ru: "Москва", en: "Moscow" },
    brand: "#ff1744",
    brandLift: "#fe3d62",
    swoosh: "#ff6479",
    fieldInk: "light",
  },
  kzn: {
    slug: "kzn",
    timezone: "Europe/Moscow",
    name: { ru: "Казань", en: "Kazan" },
    brand: "#03c452",
    brandLift: "#27cb6c",
    swoosh: "#74d992",
    fieldInk: "dark",
  },
};

export const cityList: readonly City[] = cities.map((slug) => CITIES[slug]);

export const isCitySlug = (value: unknown): value is CitySlug =>
  typeof value === "string" && (cities as readonly string[]).includes(value);

/** The branch everything predating multi-city support belongs to. */
export const DEFAULT_CITY: CitySlug = "spb";

export const cityName = (slug: CitySlug, locale: "ru" | "en"): string => CITIES[slug].name[locale];
