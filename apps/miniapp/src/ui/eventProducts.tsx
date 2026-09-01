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
  variants: Array<{ id?: number; name: string; stock: string; claimed: number }>;
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
  variants: product.variants.filter((variant) => variant.active).map((variant) => ({
    id: variant.id,
    name: variant.name,
    stock: variant.stock === null ? "" : String(variant.stock),
    claimed: variant.claimed,
  })),
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
  const setVariant = (productIndex: number, variantIndex: number, field: "name" | "stock", value: string) =>
    setProducts((current) => current.map((product, position) => position === productIndex ? {
      ...product,
      variants: product.variants.map((variant, optionPosition) => optionPosition === variantIndex ? { ...variant, [field]: value } : variant),
    } : product));
  const valid = products.every((product) => product.name.trim()
    && Number(product.price) >= 1
    && (product.stock === "" || Number(product.stock) >= 1)
    && Number(product.maxPerOrder) >= 1
    && Number(product.maxPerOrder) <= 20
    && product.variants.every((variant) => variant.name.trim() && (variant.stock === "" || Number(variant.stock) >= 1))
    && new Set(product.variants.map((variant) => variant.name.trim().toLocaleLowerCase())).size === product.variants.length);

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
      variants: product.variants.map((variant) => ({
        ...(variant.id === undefined ? {} : { id: variant.id }),
        name: variant.name.trim(),
        stock: variant.stock === "" ? null : Number(variant.stock),
        active: true,
      })),
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
            <Field label={t("products.stock")} hint={product.variants.length > 0 ? t("products.stockByOption") : product.claimed > 0 ? t("products.claimed", { n: product.claimed }) : t("products.unlimited")}>
              <TextInput disabled={product.variants.length > 0} inputMode="numeric" value={product.variants.length > 0 ? "" : product.stock} placeholder="∞" onChange={(event) => set(index, "stock", event.target.value.replace(/\D/g, ""))} />
            </Field>
            <Field label={t("products.limit")}>
              <TextInput inputMode="numeric" value={product.maxPerOrder} onChange={(event) => set(index, "maxPerOrder", event.target.value.replace(/\D/g, ""))} />
            </Field>
          </div>
          <div className="hairline" />
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="eyebrow">{t("products.options")}</div>
                <p className="mt-0.5 text-[11px] text-hint">{t("products.optionsHint")}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => set(index, "variants", [...product.variants, { name: "", stock: "", claimed: 0 }])}>
                + {t("products.addOption")}
              </Button>
            </div>
            {product.variants.length > 0 ? (
              <div className="flex flex-col gap-2">
                {product.variants.map((variant, variantIndex) => (
                  <div key={variant.id ?? `option-${variantIndex}`} className="grid grid-cols-[1fr_6rem_auto] items-end gap-2">
                    <Field label={t("products.optionName")}>
                      <TextInput value={variant.name} maxLength={40} placeholder={t("products.optionPlaceholder")} onChange={(event) => setVariant(index, variantIndex, "name", event.target.value)} />
                    </Field>
                    <Field label={t("products.stock")} hint={variant.claimed > 0 ? t("products.claimed", { n: variant.claimed }) : undefined}>
                      <TextInput inputMode="numeric" value={variant.stock} placeholder="∞" onChange={(event) => setVariant(index, variantIndex, "stock", event.target.value.replace(/\D/g, ""))} />
                    </Field>
                    <Button variant="danger" size="sm" aria-label={t("products.removeOption")} onClick={() => set(index, "variants", product.variants.filter((_, position) => position !== variantIndex))}>×</Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <Button variant="danger" size="sm" onClick={() => setProducts((current) => current.filter((_, position) => position !== index))}>
            {t("products.remove")}
          </Button>
        </section>
      ))}
      <Button variant="ghost" onClick={() => setProducts((current) => [...current, {
        kind: "merchandise", name: "", description: "", price: "", stock: "", maxPerOrder: "1", claimed: 0, variants: [],
      }])}>
        + {t("products.add")}
      </Button>
      <SheetFooter>
        <Button block loading={pending} disabled={!valid} onClick={save}>{t("products.save")}</Button>
      </SheetFooter>
    </div>
  );
};
