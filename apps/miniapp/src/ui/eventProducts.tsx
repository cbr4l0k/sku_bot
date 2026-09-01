import { useState } from "react";

import type { EventProduct, EventProductDraft } from "../api";
import { useI18n } from "../i18n";
import { SheetFooter } from "./overlays";
import { Button, Field, TextArea, TextInput } from "./primitives";

type EditableProduct = {
  id?: number;
  kind: "merchandise" | "addon";
  name: string;
  description: string;
  price: string;
  stock: string;
  maxPerOrder: string;
  claimed: number;
};

const editable = (product: EventProduct): EditableProduct => ({
  id: product.id,
  kind: product.kind,
  name: product.name,
  description: product.description ?? "",
  price: (product.priceMinor / 100).toFixed(product.priceMinor % 100 === 0 ? 0 : 2),
  stock: product.stock === null ? "" : String(product.stock),
  maxPerOrder: String(product.maxPerOrder),
  claimed: product.claimed,
});

export const EventProductEditor = ({
  initial,
  pending,
  onSave,
}: {
  initial: EventProduct[];
  pending: boolean;
  onSave: (products: EventProductDraft[]) => void;
}) => {
  const { t } = useI18n();
  const [products, setProducts] = useState<EditableProduct[]>(() => initial.filter((product) => product.active).map(editable));
  const set = <K extends keyof EditableProduct>(index: number, field: K, value: EditableProduct[K]) =>
    setProducts((current) => current.map((product, position) => position === index ? { ...product, [field]: value } : product));
  const valid = products.every((product) => product.name.trim()
    && Number(product.price) >= 1
    && (product.stock === "" || Number(product.stock) >= 1)
    && Number(product.maxPerOrder) >= 1
    && Number(product.maxPerOrder) <= 20);

  const save = () => {
    if (!valid) return;
    onSave(products.map((product) => ({
      ...(product.id === undefined ? {} : { id: product.id }),
      kind: product.kind,
      name: product.name.trim(),
      description: product.description.trim() || null,
      priceMinor: Math.round(Number(product.price) * 100),
      stock: product.stock === "" ? null : Number(product.stock),
      maxPerOrder: Number(product.maxPerOrder),
      active: true,
    })));
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] leading-relaxed text-hint">{t("products.hint")}</p>
      {products.map((product, index) => (
        <section key={product.id ?? `new-${index}`} className="card flex flex-col gap-3 px-3 py-3">
          <Field label={t("products.kind")}>
            <select className="field" value={product.kind} onChange={(event) => set(index, "kind", event.target.value as EditableProduct["kind"])}>
              <option value="merchandise">{t("products.merchandise")}</option>
              <option value="addon">{t("products.addon")}</option>
            </select>
          </Field>
          <Field label={t("products.name")}>
            <TextInput value={product.name} maxLength={80} onChange={(event) => set(index, "name", event.target.value)} />
          </Field>
          <Field label={t("products.description")}>
            <TextArea rows={2} value={product.description} maxLength={240} onChange={(event) => set(index, "description", event.target.value)} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label={t("products.price")}>
              <TextInput inputMode="decimal" value={product.price} onChange={(event) => set(index, "price", event.target.value.replace(/[^\d.,]/g, "").replace(",", "."))} />
            </Field>
            <Field label={t("products.stock")} hint={product.claimed > 0 ? t("products.claimed", { n: product.claimed }) : t("products.unlimited")}>
              <TextInput inputMode="numeric" value={product.stock} placeholder="∞" onChange={(event) => set(index, "stock", event.target.value.replace(/\D/g, ""))} />
            </Field>
            <Field label={t("products.limit")}>
              <TextInput inputMode="numeric" value={product.maxPerOrder} onChange={(event) => set(index, "maxPerOrder", event.target.value.replace(/\D/g, ""))} />
            </Field>
          </div>
          <Button variant="danger" size="sm" onClick={() => setProducts((current) => current.filter((_, position) => position !== index))}>
            {t("products.remove")}
          </Button>
        </section>
      ))}
      <Button variant="ghost" onClick={() => setProducts((current) => [...current, {
        kind: "merchandise", name: "", description: "", price: "", stock: "", maxPerOrder: "1", claimed: 0,
      }])}>
        + {t("products.add")}
      </Button>
      <SheetFooter>
        <Button block loading={pending} disabled={!valid} onClick={save}>{t("products.save")}</Button>
      </SheetFooter>
    </div>
  );
};
