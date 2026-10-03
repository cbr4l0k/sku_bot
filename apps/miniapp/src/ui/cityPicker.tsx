import { useId } from "react";

import { cityList, type CitySlug } from "@sku/cities";

import { useI18n } from "../i18n";
import { haptic } from "../telegram";

/**
 * Picking a branch: radio rows on white, each with the branch's own colour as
 * its dot, so the choice shows you what you are choosing rather than wearing
 * the current theme.
 */
export const CityPicker = ({
  value,
  onPick,
  disabled = false,
  hint,
}: {
  value: CitySlug | null;
  onPick: (city: CitySlug) => void;
  disabled?: boolean;
  hint?: string;
}) => {
  const { locale } = useI18n();
  const name = useId();

  return (
    <div className="card flex flex-col gap-1.5 p-2 text-left" role="radiogroup">
      {cityList.map((city) => (
        <label key={city.slug} className="opt">
          <input
            type="radio"
            name={name}
            checked={city.slug === value}
            disabled={disabled}
            onChange={() => {
              haptic.select();
              onPick(city.slug);
            }}
          />
          <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ background: city.brand }} />
          <span className="flex-1 font-semibold">{city.name[locale]}</span>
        </label>
      ))}
      {hint ? <p className="mx-2 mt-1 mb-1.5 text-[12px] text-hint">{hint}</p> : null}
    </div>
  );
};
