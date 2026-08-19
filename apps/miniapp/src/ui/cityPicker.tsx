import { cityList, type CitySlug } from "@sku/cities";

import { useI18n } from "../i18n";
import { haptic } from "../telegram";

/**
 * Picking a branch. Each option carries its own colours rather than the current
 * theme's, so the choice shows you what you are choosing — Moscow's chip is red
 * on the teal field and stays red once you have picked it.
 */
export const CityPicker = ({
  value,
  onPick,
  disabled = false,
}: {
  value: CitySlug | null;
  onPick: (city: CitySlug) => void;
  disabled?: boolean;
}) => {
  const { locale } = useI18n();

  return (
    <div className="flex flex-col gap-2">
      {cityList.map((city) => {
        const active = city.slug === value;
        return (
          <button
            key={city.slug}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => {
              if (active) return;
              haptic.select();
              onPick(city.slug);
            }}
            className="btn w-full justify-start gap-3 disabled:opacity-50"
            style={{
              background: active ? city.brand : "transparent",
              color: active ? (city.fieldInk === "light" ? "#ffffff" : "var(--ink-deep)") : "var(--ghost-ink)",
              boxShadow: active ? "none" : "inset 0 0 0 1px var(--ghost-line, var(--hair))",
            }}
          >
            <span
              aria-hidden
              className="inline-block h-3 w-3 shrink-0 rounded-full"
              style={{ background: city.brandLift, boxShadow: `0 0 0 2px ${city.brand}` }}
            />
            <span className="truncate">{city.name[locale]}</span>
          </button>
        );
      })}
    </div>
  );
};
