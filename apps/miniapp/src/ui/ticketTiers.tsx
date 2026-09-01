import { useState } from "react";

import type { TicketTier, TicketTierDraft } from "../api";
import { useI18n } from "../i18n";
import { Button, Field, TextInput } from "./primitives";
import { SheetFooter } from "./overlays";

type EditableTier = { id?: number; name: string; price: string; quota: string; claimed: number; salesStartAt?: string | null; salesEndAt?: string | null };
const editable = (tier: TicketTier): EditableTier => ({
  id: tier.id,
  name: tier.name,
  price: (tier.priceMinor / 100).toFixed(tier.priceMinor % 100 === 0 ? 0 : 2),
  quota: tier.quota === null ? "" : String(tier.quota),
  claimed: tier.claimed,
  salesStartAt: tier.salesStartAt,
  salesEndAt: tier.salesEndAt,
});

export const TicketTierEditor = ({
  initial,
  pending,
  onSave,
}: {
  initial: TicketTier[];
  pending: boolean;
  onSave: (tiers: TicketTierDraft[]) => void;
}) => {
  const { t } = useI18n();
  const [tiers, setTiers] = useState<EditableTier[]>(() => initial.filter((tier) => tier.active).map(editable));
  const set = (index: number, field: "name" | "price" | "quota", value: string) =>
    setTiers((current) => current.map((tier, position) => position === index ? { ...tier, [field]: value } : tier));
  const valid = tiers.every((tier) => tier.name.trim() && Number(tier.price) >= 1 && (tier.quota === "" || Number(tier.quota) >= 1));

  const save = () => {
    if (!valid) return;
    onSave(tiers.map((tier) => ({
      ...(tier.id === undefined ? {} : { id: tier.id }),
      name: tier.name.trim(),
      priceMinor: Math.round(Number(tier.price) * 100),
      quota: tier.quota === "" ? null : Number(tier.quota),
      active: true,
      salesStartAt: tier.salesStartAt ?? null,
      salesEndAt: tier.salesEndAt ?? null,
    })));
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] leading-relaxed text-hint">{t("tickets.hint")}</p>
      {tiers.map((tier, index) => (
        <section key={tier.id ?? `new-${index}`} className="card flex flex-col gap-3 px-3 py-3">
          <Field label={t("tickets.name")}>
            <TextInput value={tier.name} maxLength={80} onChange={(event) => set(index, "name", event.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("tickets.price")}>
              <TextInput
                inputMode="decimal"
                value={tier.price}
                onChange={(event) => set(index, "price", event.target.value.replace(/[^\d.,]/g, "").replace(",", "."))}
              />
            </Field>
            <Field label={t("tickets.quota")} hint={tier.claimed > 0 ? t("tickets.claimed", { n: tier.claimed }) : t("tickets.unlimited")}>
              <TextInput
                inputMode="numeric"
                value={tier.quota}
                placeholder="∞"
                onChange={(event) => set(index, "quota", event.target.value.replace(/\D/g, ""))}
              />
            </Field>
          </div>
          <Button variant="danger" size="sm" onClick={() => setTiers((current) => current.filter((_, position) => position !== index))}>
            {t("tickets.remove")}
          </Button>
        </section>
      ))}
      <Button variant="ghost" onClick={() => setTiers((current) => [...current, { name: "", price: "", quota: "", claimed: 0 }])}>
        + {t("tickets.add")}
      </Button>
      <SheetFooter>
        <Button block loading={pending} disabled={!valid} onClick={save}>{t("tickets.save")}</Button>
      </SheetFooter>
    </div>
  );
};
