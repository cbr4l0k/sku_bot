import { useState } from "react";

import { CITIES, type CitySlug } from "@sku/cities";

import type { AdminEventDraft, Group } from "../api";
import { useI18n } from "../i18n";
import { fromLocalInput, toLocalInput } from "../lib/format";
import { CityPicker } from "./cityPicker";
import { GroupPicker, HomeChatPicker } from "./groups";
import { SheetFooter } from "./overlays";
import { Button, Field, TextArea, TextInput } from "./primitives";

type Initial = Partial<AdminEventDraft>;

const emptyDraft = (initial: Initial) => ({
  title: initial.title ?? "",
  description: initial.description ?? "",
  location: initial.location ?? "",
  locationUrl: initial.locationUrl ?? "",
  startsAt: initial.startsAt ? toLocalInput(initial.startsAt) : "",
  capacity: initial.capacity === null || initial.capacity === undefined ? "" : String(initial.capacity),
});

export const EventForm = ({
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
  /** Omitted for organizers — only admins may restrict an event to groups. */
  availableGroups?: readonly Group[];
  /**
   * The branches this person may raise a run in. One is shown as a fact rather
   * than a choice; an existing event's branch is not editable here at all, since
   * moving one is an admin action with its own consequences.
   */
  cities: readonly CitySlug[];
  /** Fired so the caller can fetch the chat catalog of whichever branch is picked. */
  onCityChange?: (city: CitySlug) => void;
  onSubmit: (draft: AdminEventDraft) => void;
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
  const valid = city !== null && form.title.trim() !== "" && form.location.trim() !== "" && form.startsAt !== "" && locationUrlValid;

  const submit = () => {
    setTouched(true);
    if (!valid || city === null) return;
    onSubmit({
      city,
      title: form.title.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      locationUrl: form.locationUrl.trim() === "" ? null : form.locationUrl.trim(),
      startsAt: fromLocalInput(form.startsAt),
      capacity: form.capacity.trim() === "" ? null : Math.max(0, Number(form.capacity)),
      ...(availableGroups === undefined ? {} : { groups, homeChatId }),
    });
  };

  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  // An event already has a branch and keeps it; only a new one is still asking.
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
              // The chats on offer below belong to the branch, so they change with it.
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
      <Field label={t("form.startsAt")}>
        <TextInput
          type="datetime-local"
          value={form.startsAt}
          onChange={(event) => set("startsAt")(event.target.value)}
        />
      </Field>
      <Field label={t("form.location")}>
        <TextInput value={form.location} onChange={(event) => set("location")(event.target.value)} maxLength={160} />
      </Field>
      <Field label={t("form.locationUrl")} hint={t("form.locationUrlHint")}>
        <TextInput inputMode="url" value={form.locationUrl} onChange={(event) => set("locationUrl")(event.target.value)} placeholder={t("form.locationUrlPlaceholder")} maxLength={500} />
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
