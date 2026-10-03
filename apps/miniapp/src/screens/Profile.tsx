import { useNavigate } from "react-router";

import { sku, type Locale } from "../api";
import { useI18n } from "../i18n";
import { fullName, initials, monthYear, percent } from "../lib/format";
import { useSession } from "../session";
import { haptic, telegramUser } from "../telegram";
import { CityPicker } from "../ui/cityPicker";
import { EmptyState, PageTitle, Screen, SectionRule } from "../ui/primitives";

const LOCALES: { value: Locale; labelKey: "profile.ru" | "profile.en" }[] = [
  { value: "ru", labelKey: "profile.ru" },
  { value: "en", labelKey: "profile.en" },
];

export const ProfileScreen = () => {
  const { t, locale, setLocale } = useI18n();
  const { me, reload } = useSession();
  const navigate = useNavigate();

  const fallback = telegramUser();
  const person = me ?? (fallback ? { firstName: fallback.first_name, lastName: fallback.last_name ?? null } : null);
  const handle = [me?.username ? `@${me.username}` : null, me?.createdAt ? t("profile.sinceLine", { since: monthYear(me.createdAt, locale) }) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <Screen>
      <PageTitle title={t("profile.title")} />

      <section className="card rise p-[18px]">
        <div className="flex items-center gap-3.5">
          <span className="av h-14 w-14 text-[18px]">{person ? initials(person) : "—"}</span>
          <div className="min-w-0">
            <h2 className="display text-[18px] break-words">{person ? fullName(person) : "—"}</h2>
            {handle ? <div className="num mt-[3px] text-[11px] text-hint">{handle}</div> : null}
          </div>
        </div>
        {me ? (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="stattile px-3.5 py-3">
              <div className="eyebrow mb-1">{t("profile.runs")}</div>
              <div className="display text-[24px]">{me.stats.runs}</div>
            </div>
            <div className="stattile px-3.5 py-3">
              <div className="eyebrow mb-1">{t("profile.turnout")}</div>
              <div className="display text-[24px]">{me.stats.turnout === null ? "—" : percent(me.stats.turnout)}</div>
            </div>
          </div>
        ) : null}
      </section>

      <SectionRule label={t("profile.city")} />
      <CityPicker
        value={me?.city ?? null}
        hint={t("profile.cityHint")}
        onPick={(city) => {
          void sku.setMe({ city }).then(reload).catch(() => undefined);
        }}
      />

      <SectionRule label={t("profile.language")} />
      <div className="seg" role="group" aria-label={t("profile.language")}>
        {LOCALES.map((option) => (
          <button
            key={option.value}
            type="button"
            className="tab"
            data-active={locale === option.value}
            aria-pressed={locale === option.value}
            onClick={() => {
              haptic.select();
              setLocale(option.value);
            }}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>

      <SectionRule label={t("profile.contact")} />
      <section className="card">
        <div className="row">
          <span className="eyebrow w-[74px] shrink-0 text-[9px]">{t("profile.phone")}</span>
          <span className="num flex-1 text-[13px]">{me?.phone ?? <span className="text-hint">{t("profile.noPhone")}</span>}</span>
        </div>
        <button type="button" className="row" onClick={() => navigate("/history")}>
          <span className="flex-1 text-[14px]">{t("profile.history")}</span>
          <span className="chev">›</span>
        </button>
      </section>
      <p className="mx-1 mt-3 text-[12px]" style={{ color: "var(--ink-deep)" }}>
        {t("profile.phoneNote")}
      </p>

      {me ? null : <EmptyState text={t("app.outsideTelegram")} />}
    </Screen>
  );
};
