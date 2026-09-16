import { useState } from "react";

import { CITIES, type CitySlug } from "@sku/cities";

import type { Group, SeriesDraft } from "../api";
import { useI18n } from "../i18n";
import { fromLocalInput, toLocalInput } from "../lib/format";
import { CityPicker } from "./cityPicker";
import { GroupPicker, HomeChatPicker } from "./groups";
import { SheetFooter } from "./overlays";
import { Button, Field, TextArea, TextInput } from "./primitives";

type Initial = Partial<SeriesDraft>;

const emptyDraft = (initial: Initial) => ({
  title: initial.title ?? "",
  description: initial.description ?? "",
  location: initial.location ?? "",
  locationUrl: initial.locationUrl ?? "",
  nextStartsAt: initial.nextStartsAt ? toLocalInput(initial.nextStartsAt) : "",
  capacity: initial.capacity === null || initial.capacity === undefined ? "" : String(initial.capacity),
  cadenceDays: initial.cadenceDays === null || initial.cadenceDays === undefined ? "" : String(initial.cadenceDays),
  leadDays: initial.leadDays === undefined ? "14" : String(initial.leadDays),
});

/**
 * The template behind a repeating run. Deliberately the event form minus the
 * date and plus the schedule: a series owns everything that stays the same, and
 * the one date it carries is only the *next* one, which the detail screen is
 * built to move.
 */
export const SeriesForm = ({
  initial = {},
  submitLabel,
  pending = false,
  availableGroups,
  cities,
  onCityChange,
  onSubmit,
}: {
  initial?: Initial;
  submitLabel: string;
  pending?: boolean;
  availableGroups?: readonly Group[];
  cities: readonly CitySlug[];
  onCityChange?: (city: CitySlug) => void;
  onSubmit: (draft: SeriesDraft) => void;
}) => {
  const { t, locale } = useI18n();
  const [form, setForm] = useState(() => emptyDraft(initial));
  const [city, setCity] = useState<CitySlug | null>(() => initial.city ?? cities[0] ?? null);
  const [groups, setGroups] = useState<number[]>(() => [...(initial.groups ?? [])]);
  const [homeChatId, setHomeChatId] = useState<number | null>(() => initial.homeChatId ?? null);
  const [touched, setTouched] = useState(false);

  const locationUrlValid = form.locationUrl.trim() === "" || (() => {
    try { return new URL(form.locationUrl.trim()).protocol === "https:"; } catch { return false; }
  })();
  const valid = city !== null && form.title.trim() !== "" && form.location.trim() !== "" && locationUrlValid;

  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    setTouched(true);
    if (!valid || city === null) return;
    onSubmit({
      city,
      title: form.title.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      locationUrl: form.locationUrl.trim() === "" ? null : form.locationUrl.trim(),
      // A series may exist with no date at all — that is how an irregular one
      // waits for a person to say when the next run is.
      nextStartsAt: form.nextStartsAt === "" ? null : fromLocalInput(form.nextStartsAt),
      capacity: form.capacity.trim() === "" ? null : Math.max(0, Number(form.capacity)),
      cadenceDays: form.cadenceDays.trim() === "" ? null : Math.max(1, Number(form.cadenceDays)),
      leadDays: form.leadDays.trim() === "" ? 14 : Math.max(0, Number(form.leadDays)),
      ...(availableGroups === undefined ? {} : { groups, homeChatId }),
    });
  };

  const lockedCity = initial.city ?? (cities.length === 1 ? cities[0] : undefined);

  return (
    <div className="flex flex-col gap-4">
      <Field label={t("form.city")} hint={lockedCity ? undefined : t("form.cityHint")}>
        {lockedCity ? (
          <div className="flex items-center gap-2 text-[14px]">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: CITIES[lockedCity].brandLift, boxShadow: `0 0 0 2px ${CITIES[lockedCity].brand}` }}
            />
            {CITIES[lockedCity].name[locale]}
          </div>
        ) : (
          <CityPicker
            value={city}
            onPick={(next) => {
              setCity(next);
              setGroups([]);
              setHomeChatId(null);
              onCityChange?.(next);
            }}
          />
        )}
      </Field>

      <Field label={t("form.title")}>
        <TextInput value={form.title} onChange={(event) => set("title")(event.target.value)} maxLength={120} />
      </Field>
      <Field label={t("form.location")}>
        <TextInput value={form.location} onChange={(event) => set("location")(event.target.value)} maxLength={160} />
      </Field>
      <Field label={t("form.locationUrl")} hint={t("form.locationUrlHint")}>
        <TextInput
          inputMode="url"
          value={form.locationUrl}
          onChange={(event) => set("locationUrl")(event.target.value)}
          placeholder={t("form.locationUrlPlaceholder")}
          maxLength={500}
        />
      </Field>
      <Field label={t("form.capacity")} hint={t("form.capacityHint")}>
        <TextInput
          inputMode="numeric"
          value={form.capacity}
          onChange={(event) => set("capacity")(event.target.value.replace(/\D/g, ""))}
          placeholder="∞"
        />
      </Field>
      <Field label={t("form.description")}>
        <TextArea value={form.description} onChange={(event) => set("description")(event.target.value)} />
      </Field>

      <Field label={t("series.next")} hint={t("series.moveHint")}>
        <TextInput
          type="datetime-local"
          value={form.nextStartsAt}
          onChange={(event) => set("nextStartsAt")(event.target.value)}
        />
      </Field>
      <div className="flex gap-3">
        <div className="flex-1">
          <Field label={t("series.cadence")} hint={t("series.cadenceHint")}>
            <TextInput
              inputMode="numeric"
              value={form.cadenceDays}
              onChange={(event) => set("cadenceDays")(event.target.value.replace(/\D/g, ""))}
              placeholder={t("series.byHand")}
            />
          </Field>
        </div>
        <div className="w-[38%]">
          <Field label={t("series.lead")} hint={t("series.leadHint")}>
            <TextInput
              inputMode="numeric"
              value={form.leadDays}
              onChange={(event) => set("leadDays")(event.target.value.replace(/\D/g, ""))}
            />
          </Field>
        </div>
      </div>

      {availableGroups === undefined ? null : (
        <>
          <Field label={t("form.groups")} hint={t("form.groupsHint")}>
            <GroupPicker available={availableGroups} value={groups} onChange={setGroups} />
          </Field>
          <Field label={t("form.homeChat")} hint={t("form.homeChatHint")}>
            <HomeChatPicker available={availableGroups} value={homeChatId} onChange={setHomeChatId} />
          </Field>
        </>
      )}

      {touched && !valid ? (
        <p className="text-[12px]" style={{ color: "var(--danger)" }}>
          {locationUrlValid ? t("form.required") : t("form.invalidLocationUrl")}
        </p>
      ) : null}

      <SheetFooter>
        <Button block loading={pending} onClick={submit}>
          {submitLabel}
        </Button>
      </SheetFooter>
    </div>
  );
};
