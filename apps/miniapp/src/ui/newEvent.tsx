import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

import { CITIES, type CitySlug } from "@sku/cities";

import { sku, type EventSummary } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { errorText, fromLocalInput, fullName, money, shortDate, timeOf } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { haptic } from "../telegram";
import { CityPicker } from "./cityPicker";
import { DateBlock, PriceChip } from "./event";
import { OrganizersSheet } from "./eventAdmin";
import { EventProductEditor } from "./eventProducts";
import { GroupPicker, HomeChatPicker } from "./groups";
import { Sheet, SheetFooter, useToast } from "./overlays";
import { Button, Field, TextArea, TextInput } from "./primitives";
import { TicketTierEditor } from "./ticketTiers";

type Step = 0 | 1 | 2 | 3;

const STEPS: ReadonlyArray<MessageKey> = ["newEvent.stepBasics", "newEvent.stepSignup", "newEvent.stepVisibility"];
const HEADLINES: ReadonlyArray<MessageKey> = ["newEvent.headBasics", "newEvent.headSignup", "newEvent.headVisibility", "newEvent.headReview"];

/**
 * A new event in three short steps, then a look at it the way runners will see
 * it. The draft exists from the first "Next" on, so closing halfway loses
 * nothing — it waits in HQ like any other draft.
 */
export const NewEventSheet = ({ cities, onClose }: { cities: readonly CitySlug[]; onClose: () => void }) => {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const action = useAction();
  const [step, setStep] = useState<Step>(0);
  const [eventId, setEventId] = useState<number | null>(null);
  const [nested, setNested] = useState<"tiers" | "products" | "organizers" | null>(null);

  const [city, setCity] = useState<CitySlug | null>(cities[0] ?? null);
  const [basics, setBasics] = useState({ title: "", startsAt: "", location: "", locationUrl: "", description: "" });
  const [ticketed, setTicketed] = useState(false);
  const [spots, setSpots] = useState("");
  const [queue, setQueue] = useState(true);
  const [groups, setGroups] = useState<number[]>([]);
  const [homeChatId, setHomeChatId] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);

  // The draft as the server holds it — tiers, merch and organizers live there, not here.
  const event = useResource(
    useCallback(async (): Promise<EventSummary | null> => {
      if (eventId === null) return null;
      return (await sku.organizerEvents()).find((item) => item.id === eventId) ?? null;
    }, [eventId]),
  );
  const summary = useResource(useCallback(() => (eventId === null ? Promise.resolve(null) : sku.eventSummary(eventId)), [eventId]));
  const catalog = useResource(useCallback(() => (city ? sku.groupCatalog(city) : Promise.resolve({ groups: [] })), [city]));
  const draft = event.data ?? null;

  const urlValid = basics.locationUrl.trim() === "" || (() => {
    try {
      return new URL(basics.locationUrl.trim()).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const basicsValid = city !== null && basics.title.trim() !== "" && basics.startsAt !== "" && basics.location.trim() !== "" && urlValid;

  const go = (next: Step) => {
    haptic.select();
    setTouched(false);
    setStep(next);
  };

  const fail = (error: Error) => toast(errorText(t, error), "err");

  const saveBasics = () => {
    setTouched(true);
    if (!basicsValid || city === null) return;
    const body = {
      title: basics.title.trim(),
      description: basics.description.trim(),
      startsAt: fromLocalInput(basics.startsAt),
      location: basics.location.trim(),
      locationUrl: basics.locationUrl.trim() || null,
    };
    void action.run(async () => {
      if (eventId === null) {
        const created = await sku.createEvent({ ...body, city, capacity: null, status: "draft" });
        setEventId(created.id);
      } else {
        await sku.updateEvent(eventId, body);
        await event.reload(true);
      }
      go(1);
    }, { onError: fail });
  };

  // "Ticketed" is only a choice on this screen until a tier exists on the server.
  const missingTier = () => ticketed && !(draft?.ticketTiers ?? []).some((tier) => tier.active);

  const saveSignup = () => {
    if (eventId === null) return;
    if (missingTier()) {
      toast(t("newEvent.needTier"), "err");
      return;
    }
    void action.run(async () => {
      await sku.updateEvent(eventId, { capacity: spots === "" ? null : Number(spots), waitlistEnabled: queue });
      // Switching back to free clears the tiers, or the server would still ask for payment.
      if (!ticketed && (draft?.ticketTiers.length ?? 0) > 0) await sku.setTicketTiers(eventId, []);
      await event.reload(true);
      go(2);
    }, { onError: fail });
  };

  const saveVisibility = () => {
    if (eventId === null) return;
    void action.run(async () => {
      await sku.adminUpdateEvent(eventId, { groups, homeChatId });
      await Promise.all([event.reload(true), summary.reload(true)]);
      go(3);
    }, { onError: fail });
  };

  const finish = (publish: boolean) => {
    if (eventId === null) return;
    if (publish && missingTier()) {
      toast(t("newEvent.needTier"), "err");
      go(1);
      return;
    }
    void action.run(async () => {
      if (publish) {
        await sku.adminUpdateEvent(eventId, { status: "published" });
        toast(t("hq.published"));
      }
      onClose();
      navigate(`/hq/events/${eventId}`);
    }, { onError: fail });
  };

  const tiers = (draft?.ticketTiers ?? []).filter((tier) => tier.active);
  const products = (draft?.products ?? []).filter((product) => product.active);
  const chatTitle = (id: number) => (catalog.data?.groups ?? []).find((group) => group.id === id)?.title ?? String(id);

  return (
    <Sheet title={step < 3 ? t("newEvent.eyebrowStep", { n: step + 1 }) : t("newEvent.eyebrowReview")} onClose={onClose} full>
      <h2 className="display mb-3.5 text-[16px]">{t(HEADLINES[step] ?? "newEvent.headReview")}</h2>
      {step < 3 ? (
        <ol className="mb-5 grid grid-cols-3 gap-1.5">
          {STEPS.map((key, index) => (
            <li key={key}>
              <div className="mb-1.5 h-1 rounded-full" style={{ background: index <= step ? "var(--brand-deep)" : "var(--veil)" }} />
              <div className="num text-[9px] tracking-[0.12em] uppercase" style={{ color: index === step ? "var(--brand-ink)" : "var(--paper-ink-dim)" }}>
                {t(key)}
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {step === 0 ? (
        <div className="flex flex-col gap-4">
          {cities.length > 1 && eventId === null ? (
            <Field label={t("form.city")}>
              <CityPicker
                value={city}
                onPick={(next) => {
                  setCity(next);
                  setGroups([]);
                  setHomeChatId(null);
                }}
              />
            </Field>
          ) : null}
          <Field label={t("form.title")}>
            <TextInput value={basics.title} maxLength={120} onChange={(event_) => setBasics((current) => ({ ...current, title: event_.target.value }))} />
          </Field>
          <Field label={t("form.startsAt")}>
            <TextInput type="datetime-local" value={basics.startsAt} onChange={(event_) => setBasics((current) => ({ ...current, startsAt: event_.target.value }))} />
          </Field>
          <Field label={t("form.location")}>
            <TextInput value={basics.location} maxLength={160} onChange={(event_) => setBasics((current) => ({ ...current, location: event_.target.value }))} />
          </Field>
          <Field label={t("form.locationUrl")} hint={t("form.locationUrlHint")}>
            <TextInput
              inputMode="url"
              value={basics.locationUrl}
              placeholder={t("form.locationUrlPlaceholder")}
              maxLength={500}
              onChange={(event_) => setBasics((current) => ({ ...current, locationUrl: event_.target.value }))}
            />
          </Field>
          <Field label={t("form.description")}>
            <TextArea value={basics.description} onChange={(event_) => setBasics((current) => ({ ...current, description: event_.target.value }))} />
          </Field>
          {touched && !basicsValid ? (
            <p className="text-[12px]" style={{ color: "var(--danger)" }}>
              {urlValid ? t("form.required") : t("form.invalidLocationUrl")}
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="flex flex-col gap-[18px]">
          <div>
            <span className="eyebrow mb-2 block">{t("newEvent.entry")}</span>
            <div className="seg" role="radiogroup" aria-label={t("newEvent.entry")}>
              {([false, true] as const).map((value) => (
                <button key={String(value)} type="button" role="radio" aria-checked={ticketed === value} className="tab" data-active={ticketed === value} onClick={() => setTicketed(value)}>
                  {t(value ? "newEvent.ticketed" : "events.free")}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t("manage.totalSpots")} hint={t("manage.totalSpotsHint")}>
              <TextInput inputMode="numeric" placeholder="∞" value={spots} onChange={(event_) => setSpots(event_.target.value.replace(/\D/g, ""))} />
            </Field>
            <div>
              <span className="eyebrow mb-1.5 block">{t("manage.waitlist")}</span>
              <div className="flex h-[46px] items-center gap-2.5">
                <button type="button" className="switch" aria-pressed={queue} aria-label={t("manage.waitlist")} onClick={() => setQueue((value) => !value)}>
                  <span />
                </button>
                <span className="text-[13px]">{t(queue ? "newEvent.on" : "newEvent.off")}</span>
              </div>
            </div>
          </div>
          {ticketed ? (
            <ItemList
              label={t("tickets.title")}
              aside={t("manage.tiersN", { n: tiers.length })}
              rows={tiers.map((tier) => ({
                key: tier.id,
                name: tier.name,
                hint: [tier.quota === null ? t("manage.noLimit") : t("newEvent.pcs", { n: tier.quota }), tier.description].filter(Boolean).join(" · "),
                value: money(tier.priceMinor, locale),
              }))}
              addLabel={t("newEvent.addTier")}
              onOpen={() => setNested("tiers")}
            />
          ) : null}
          <ItemList
            label={t("newEvent.merch")}
            aside={t("checkout.optional")}
            rows={products.map((product) => ({
              key: product.id,
              name: product.name,
              hint: product.variants.filter((variant) => variant.active).map((variant) => variant.name).join(", "),
              value: money(product.priceMinor, locale),
            }))}
            addLabel={t("newEvent.addItem")}
            onOpen={() => setNested("products")}
          />
        </div>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-4">
          <Field label={t("form.groups")} hint={t("form.groupsHint")}>
            <GroupPicker available={catalog.data?.groups ?? []} value={groups} onChange={setGroups} />
          </Field>
          <Field label={t("form.homeChat")} hint={t("form.homeChatHint")}>
            <HomeChatPicker available={catalog.data?.groups ?? []} value={homeChatId} onChange={setHomeChatId} />
          </Field>
          <div className="card bg-white">
            <button type="button" className="row" onClick={() => setNested("organizers")}>
              <span className="eyebrow w-[78px] shrink-0 text-[9px]">{t("detail.ledBy")}</span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{summary.data?.organizers.map(fullName).join(", ") || "—"}</span>
              <span className="chev">›</span>
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 && draft ? (
        <div className="flex flex-col gap-3.5">
          <div className="rounded-[20px] p-3.5" style={{ background: "var(--brand)" }}>
            <div className="card p-4">
              <div className="flex gap-3.5">
                <DateBlock iso={draft.startsAt} />
                <div className="min-w-0 flex-1">
                  <h3 className="display mb-1 text-[16px] leading-[1.15] break-words">{draft.title}</h3>
                  <p className="mb-3 truncate text-[13px] text-hint">{draft.location}</p>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="num text-[11px] tracking-[0.14em] text-hint uppercase">{t("newEvent.open")}</span>
                    <span className="num text-[11px]">{draft.capacity === null ? "0" : `0/${draft.capacity}`}</span>
                  </div>
                  <div className="track" />
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <PriceChip event={draft} />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="card bg-white">
            <ReviewRow label={t("detail.when")} value={`${shortDate(draft.startsAt, locale)}, ${timeOf(draft.startsAt, locale)}`} onPress={() => go(0)} />
            <ReviewRow
              label={t("newEvent.signup")}
              value={[
                draft.capacity === null ? t("manage.noLimit") : t("manage.spotsN", { n: draft.capacity }),
                draft.waitlistEnabled ? t("newEvent.withQueue") : null,
                tiers.length ? t("manage.tiersN", { n: tiers.length }) : t("events.free"),
              ].filter(Boolean).join(" · ")}
              onPress={() => go(1)}
            />
            <ReviewRow
              label={t("newEvent.visibleTo")}
              value={draft.groups.length ? draft.groups.map((group) => group.title).join(", ") : t("manage.everyone", { city: CITIES[draft.city].name[locale] })}
              onPress={() => go(2)}
            />
            <ReviewRow label={t("series.chat")} value={draft.homeChat ? draft.homeChat.title : homeChatId ? chatTitle(homeChatId) : "—"} onPress={() => go(2)} />
            <ReviewRow label={t("detail.ledBy")} value={summary.data?.organizers.map((person) => person.firstName).join(", ") || "—"} onPress={() => setNested("organizers")} />
          </div>
          <p className="rounded-[14px] px-3.5 py-3 text-[12px] leading-[1.5]" style={{ background: "var(--flare-soft)" }}>
            {t("newEvent.publishNote")}
          </p>
        </div>
      ) : null}

      <SheetFooter>
        {step === 3 ? (
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <Button variant="ghost" disabled={action.pending} onClick={() => finish(false)}>
              {t("phase.draft")}
            </Button>
            <Button loading={action.pending} onClick={() => finish(true)}>
              {t("hq.publish")}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <Button variant="ghost" disabled={step === 0 || action.pending} onClick={() => go((step - 1) as Step)}>
                {t("common.back")}
              </Button>
              <Button loading={action.pending} onClick={step === 0 ? saveBasics : step === 1 ? saveSignup : saveVisibility}>
                {t("newEvent.next")}
              </Button>
            </div>
            <p className="mt-2.5 text-center text-[11px] text-hint">{t("newEvent.draftNote")}</p>
          </>
        )}
      </SheetFooter>

      {nested === "tiers" && eventId !== null ? (
        <Sheet title={t("tickets.title")} onClose={() => setNested(null)}>
          <TicketTierEditor
            initial={draft?.ticketTiers ?? []}
            pending={action.pending}
            onSave={(next) =>
              void action.run(async () => {
                await sku.setTicketTiers(eventId, next);
                await event.reload(true);
                setNested(null);
              }, { onError: fail })
            }
          />
        </Sheet>
      ) : null}
      {nested === "products" && eventId !== null ? (
        <Sheet title={t("products.title")} onClose={() => setNested(null)}>
          <EventProductEditor
            initial={draft?.products ?? []}
            pending={action.pending}
            onSave={(next) =>
              void action.run(async () => {
                await sku.setProducts(eventId, next);
                await event.reload(true);
                setNested(null);
              }, { onError: fail })
            }
          />
        </Sheet>
      ) : null}
      {nested === "organizers" && eventId !== null ? (
        <OrganizersSheet
          eventId={eventId}
          onClose={() => {
            setNested(null);
            void summary.reload(true);
          }}
        />
      ) : null}
    </Sheet>
  );
};

const ItemList = ({
  label,
  aside,
  rows,
  addLabel,
  onOpen,
}: {
  label: string;
  aside: string;
  rows: ReadonlyArray<{ key: number; name: string; hint: string; value: string }>;
  addLabel: string;
  onOpen: () => void;
}) => (
  <div>
    <div className="mb-2 flex items-baseline justify-between">
      <span className="eyebrow">{label}</span>
      <span className="num text-[11px] text-hint">{aside}</span>
    </div>
    <div className="card bg-white">
      {rows.map((row) => (
        <button key={row.key} type="button" className="row" onClick={onOpen}>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold">{row.name}</span>
            {row.hint ? <span className="num block text-[11px] text-hint">{row.hint}</span> : null}
          </span>
          <span className="num">{row.value}</span>
          <span className="chev">›</span>
        </button>
      ))}
      <button type="button" className="row" onClick={onOpen}>
        <span className="text-[14px] font-semibold" style={{ color: "var(--brand-deep)" }}>
          + {addLabel}
        </span>
      </button>
    </div>
  </div>
);

const ReviewRow = ({ label, value, onPress }: { label: string; value: string; onPress: () => void }) => (
  <button type="button" className="row" onClick={onPress}>
    <span className="eyebrow w-[78px] shrink-0 text-[9px]">{label}</span>
    <span className="min-w-0 flex-1 truncate text-[13px]">{value}</span>
    <span className="chev">›</span>
  </button>
);
