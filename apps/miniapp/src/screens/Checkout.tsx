import { useCallback, useState } from "react";
import { useParams, useSearchParams } from "react-router";

import { sku, type EventDetail, type EventProduct } from "../api";
import { useI18n } from "../i18n";
import { errorText, money, shortDate, timeOf } from "../lib/format";
import { useBackButton } from "../lib/useBackButton";
import { useAction, useResource } from "../lib/useResource";
import { haptic, openLink } from "../telegram";
import { useDockAction } from "../ui/dock";
import { PriceChip, tierOnSale } from "../ui/event";
import { useToast } from "../ui/overlays";
import { ErrorState, Loader, Screen, SectionRule } from "../ui/primitives";

export const CheckoutScreen = () => {
  const { t } = useI18n();
  const params = useParams();
  const id = Number(params.id);
  useBackButton(`/events/${id}`);
  const event = useResource(useCallback(() => sku.event(id), [id]));

  if (!event.data) {
    return (
      <Screen>
        <PendingDock />
        {event.loading ? (
          <Loader label={t("common.loading")} />
        ) : (
          <ErrorState message={errorText(t, event.error)} retryLabel={t("common.retry")} onRetry={() => void event.reload()} />
        )}
      </Screen>
    );
  }
  return <Basket detail={event.data} reload={() => event.reload(true)} />;
};

const PendingDock = () => {
  const { t } = useI18n();
  useDockAction({ label: t("common.loading"), loading: true, quiet: true });
  return null;
};

const NO_TICKET = 0;

const variantsOnSale = (product: EventProduct) =>
  product.variants.filter((variant) => variant.active && (variant.stock === null || variant.claimed < variant.stock));

const onSale = (product: EventProduct) =>
  product.active &&
  (product.variants.length > 0 ? variantsOnSale(product).length > 0 : product.stock === null || product.claimed < product.stock);

/** How many more of this line one order may take, given stock and the per-order cap. */
const headroom = (product: EventProduct, variantId: number | null) => {
  const variant = product.variants.find((option) => option.id === variantId);
  const stock = product.variants.length > 0 ? variant?.stock ?? null : product.stock;
  const claimed = product.variants.length > 0 ? variant?.claimed ?? 0 : product.claimed;
  return stock === null ? product.maxPerOrder : Math.min(product.maxPerOrder, stock - claimed);
};

const Basket = ({ detail, reload }: { detail: EventDetail; reload: () => Promise<void> }) => {
  const { t, locale } = useI18n();
  const toast = useToast();
  const action = useAction();
  const [searchParams] = useSearchParams();
  const holds = detail.myRegistrationStatus === "registered" || detail.myRegistrationStatus === "checked_in";
  const now = Date.now();
  const tiers = holds
    ? []
    : detail.ticketTiers.filter((tier) => tierOnSale(tier, now));
  const products = detail.products.filter(onSale);
  // Merch can be bought without a seat, but only offered that way when there is merch.
  const canSkipTicket = products.length > 0;

  const [tierId, setTierId] = useState<number>(() => {
    const wanted = Number(searchParams.get("ticket"));
    return tiers.find((tier) => tier.id === wanted)?.id ?? tiers[0]?.id ?? NO_TICKET;
  });
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [variants, setVariants] = useState<Record<number, number>>({});

  const tier = tiers.find((option) => option.id === tierId) ?? null;
  const quantityOf = (product: EventProduct) => {
    if (product.variants.length > 0 && !variantsOnSale(product).some((variant) => variant.id === variants[product.id])) return 0;
    return quantities[product.id] ?? 0;
  };
  const setQuantity = (productId: number, quantity: number) =>
    setQuantities((current) => {
      const { [productId]: _dropped, ...rest } = current;
      return quantity > 0 ? { ...rest, [productId]: quantity } : rest;
    });

  const lines = [
    ...(tier ? [{ key: `tier-${tier.id}`, name: tier.name, amount: tier.priceMinor }] : []),
    ...products
      .filter((product) => quantityOf(product) > 0)
      .map((product) => {
        const variant = product.variants.find((option) => option.id === variants[product.id]);
        const quantity = quantityOf(product);
        return {
          key: `product-${product.id}`,
          name: `${product.name}${variant ? ` · ${variant.name}` : ""}${quantity > 1 ? ` × ${quantity}` : ""}`,
          amount: product.priceMinor * quantity,
        };
      }),
  ];
  const total = lines.reduce((sum, line) => sum + line.amount, 0);

  const pay = () => {
    const items = products
      .map((product) => ({
        productId: product.id,
        variantId: product.variants.length > 0 ? variants[product.id] ?? null : null,
        quantity: quantityOf(product),
      }))
      .filter((item) => item.quantity > 0);
    if (!tier && items.length === 0) return;
    void action.run(
      async () => {
        const checkout = await sku.checkout(detail.id, tier?.id ?? null, items);
        if (!checkout.confirmationUrl) {
          await reload();
          return;
        }
        toast(t("toast.paymentOpened"));
        openLink(checkout.confirmationUrl);
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );
  };

  useDockAction(
    !detail.paymentsConfigured
      ? { label: t("detail.paymentsUnavailable"), quiet: true }
      : lines.length === 0
        ? { label: t("detail.pickPurchase"), quiet: true }
        : { label: t("action.pay", { price: money(total, locale) }), onPress: pay, loading: action.pending },
  );

  return (
    <Screen className="pb-[calc(8rem_+_var(--safe-bottom))]">
      <div className="rise mb-3.5 flex gap-1.5">
        <PriceChip event={detail} tone="soft" />
      </div>
      <h1 className="hero rise mb-2.5 break-words">{detail.title}</h1>
      <p className="rise text-[13px]" style={{ color: "var(--ink-deep)" }}>
        {shortDate(detail.startsAt, locale)} · {timeOf(detail.startsAt, locale)} · {detail.location}
      </p>

      {tiers.length > 0 || (!holds && detail.ticketTiers.length > 0) ? (
        <>
          <SectionRule label={t("checkout.ticket")} />
          <fieldset className="card rise flex flex-col gap-1.5 p-2" style={{ "--i": 1 } as React.CSSProperties}>
            <legend className="sr-only">{t("checkout.ticket")}</legend>
            {tiers.map((option) => {
              const left = option.quota === null ? null : Math.max(0, option.quota - option.claimed);
              const hint = [option.description, left !== null && left <= 20 ? t("detail.ticketQuota", { n: left }) : null].filter(Boolean).join(" · ");
              return (
                <label key={option.id} className="opt">
                  <input type="radio" name="tier" checked={tierId === option.id} onChange={() => { haptic.select(); setTierId(option.id); }} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{option.name}</span>
                    {hint ? <span className="block text-[12px] text-hint">{hint}</span> : null}
                  </span>
                  <span className="num">{money(option.priceMinor, locale)}</span>
                </label>
              );
            })}
            {tiers.length === 0 ? <p className="px-2 py-3 text-[13px] text-hint">{t("detail.noTicketsAvailable")}</p> : null}
            {canSkipTicket ? (
              <label className="opt">
                <input type="radio" name="tier" checked={tierId === NO_TICKET} onChange={() => { haptic.select(); setTierId(NO_TICKET); }} />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{t("checkout.noTicket")}</span>
                  <span className="block text-[12px] text-hint">{t("checkout.noTicketHint")}</span>
                </span>
                <span className="num">{money(0, locale)}</span>
              </label>
            ) : null}
          </fieldset>
        </>
      ) : null}

      {products.length > 0 ? (
        <>
          <div className="mt-7 mb-3 flex items-center gap-3">
            <span className="eyebrow shrink-0">{t("checkout.add")}</span>
            <span className="hairline flex-1" />
            <span className="num shrink-0 text-[11px] text-hint">{t("checkout.optional")}</span>
          </div>
          <div className="card rise" style={{ "--i": 2 } as React.CSSProperties}>
            {products.map((product) => {
              const quantity = quantityOf(product);
              const options = product.variants.filter((variant) => variant.active);
              const picked = variants[product.id] ?? null;
              const room = headroom(product, picked);
              return (
                <div key={product.id} className="row block">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold">{product.name}</div>
                      {product.description ? <div className="text-[12px] text-hint">{product.description}</div> : null}
                    </div>
                    {options.length > 0 || quantity > 0 ? <span className="num shrink-0">{money(product.priceMinor, locale)}</span> : null}
                    {options.length === 0 && quantity === 0 ? (
                      <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => { haptic.select(); setQuantity(product.id, 1); }}>
                        + {money(product.priceMinor, locale)}
                      </button>
                    ) : null}
                  </div>
                  {options.length > 0 || quantity > 0 ? (
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("detail.chooseOptionFor", { product: product.name })}>
                        {options.map((variant) => {
                          const soldOut = variant.stock !== null && variant.claimed >= variant.stock;
                          const on = picked === variant.id;
                          return (
                            <button
                              key={variant.id}
                              type="button"
                              disabled={soldOut}
                              aria-pressed={on}
                              className={`chip px-[11px] py-[7px] disabled:opacity-45 ${on ? "chip-flare" : ""}`}
                              onClick={() => {
                                haptic.select();
                                if (on) {
                                  setQuantity(product.id, 0);
                                  setVariants(({ [product.id]: _dropped, ...rest }) => rest);
                                  return;
                                }
                                setVariants((current) => ({ ...current, [product.id]: variant.id }));
                                setQuantity(product.id, Math.max(1, Math.min(quantity, headroom(product, variant.id))));
                              }}
                            >
                              {variant.name}
                            </button>
                          );
                        })}
                      </div>
                      {quantity > 0 ? (
                        <div className="flex shrink-0 items-center gap-2.5">
                          <button type="button" className="btn btn-ghost btn-sm min-w-9 px-2" aria-label={t("checkout.less")} onClick={() => setQuantity(product.id, quantity - 1)}>
                            −
                          </button>
                          <span className="num w-4 text-center">{quantity}</span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm min-w-9 px-2"
                            aria-label={t("checkout.more")}
                            disabled={quantity >= room}
                            onClick={() => setQuantity(product.id, quantity + 1)}
                          >
                            +
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {lines.length > 0 ? (
        <>
          <SectionRule label={t("checkout.order")} />
          <section className="card rise p-4" style={{ "--i": 3 } as React.CSSProperties}>
            <div className="flex flex-col gap-1.5">
              {lines.map((line) => (
                <div key={line.key} className="flex justify-between gap-3 text-[14px]">
                  <span className="min-w-0 break-words">{line.name}</span>
                  <span className="num shrink-0">{money(line.amount, locale)}</span>
                </div>
              ))}
            </div>
            <div className="hairline my-3" />
            <div className="flex items-baseline justify-between">
              <span className="eyebrow">{t("purchases.total")}</span>
              <span className="display text-[22px]">{money(total, locale)}</span>
            </div>
          </section>
        </>
      ) : null}

      <p className="mx-1 mt-3 text-[12px]" style={{ color: "var(--ink-deep)" }}>
        {t("checkout.note")}
      </p>
    </Screen>
  );
};
