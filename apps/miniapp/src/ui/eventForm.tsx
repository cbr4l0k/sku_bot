import { useState } from "react";

import type { EventDraft } from "../api";
import { useI18n } from "../i18n";
import { fromLocalInput, toLocalInput } from "../lib/format";
import { SheetFooter } from "./overlays";
import { Button, Field, TextArea, TextInput } from "./primitives";

type Initial = Partial<EventDraft>;

const emptyDraft = (initial: Initial) => ({
  title: initial.title ?? "",
  description: initial.description ?? "",
  location: initial.location ?? "",
  startsAt: initial.startsAt ? toLocalInput(initial.startsAt) : "",
  capacity: initial.capacity === null || initial.capacity === undefined ? "" : String(initial.capacity),
});

export const EventForm = ({
  initial = {},
  submitLabel,
  pending = false,
  onSubmit,
}: {
  initial?: Initial;
  submitLabel: string;
  pending?: boolean;
  onSubmit: (draft: EventDraft) => void;
}) => {
  const { t } = useI18n();
  const [form, setForm] = useState(() => emptyDraft(initial));
  const [touched, setTouched] = useState(false);

  const valid = form.title.trim() !== "" && form.location.trim() !== "" && form.startsAt !== "";

  const submit = () => {
    setTouched(true);
    if (!valid) return;
    onSubmit({
      title: form.title.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      startsAt: fromLocalInput(form.startsAt),
      capacity: form.capacity.trim() === "" ? null : Math.max(0, Number(form.capacity)),
    });
  };

  const set = (key: keyof typeof form) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="flex flex-col gap-4">
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

      {touched && !valid ? (
        <p className="text-[12px]" style={{ color: "var(--color-danger)" }}>
          {t("form.required")}
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
