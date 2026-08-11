import type { Locale } from "../api";
import { useI18n } from "../i18n";
import { bib, fullName } from "../lib/format";
import { useSession } from "../session";
import { haptic, telegramUser } from "../telegram";
import { Chip, EmptyState, PageTitle, Screen } from "../ui/primitives";

const LOCALES: { value: Locale; labelKey: "profile.ru" | "profile.en" }[] = [
  { value: "ru", labelKey: "profile.ru" },
  { value: "en", labelKey: "profile.en" },
];

export const ProfileScreen = () => {
  const { t, locale, setLocale } = useI18n();
  const { me } = useSession();

  const fallbackName = telegramUser();
  const name = me
    ? fullName(me)
    : fallbackName
      ? [fallbackName.first_name, fallbackName.last_name].filter(Boolean).join(" ")
      : "—";

  return (
    <Screen>
      <PageTitle title={t("profile.title")} />

      <section className="rise card mb-4 px-5 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="display text-[22px] leading-tight">{name}</h2>
            {me?.username ? <p className="num mt-1 text-[12px] text-hint">@{me.username}</p> : null}
          </div>
          <span className="num text-[11px] tracking-[0.2em] text-hint">{me ? bib(me.id) : "—"}</span>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {me?.isAdmin ? <Chip tone="flare">{t("profile.roleAdmin")}</Chip> : null}
          {me?.isOrganizerOfAny ? <Chip tone="soft">{t("profile.roleOrganizer")}</Chip> : null}
        </div>

        <div className="hairline my-4" />

        <dl className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="eyebrow">{t("profile.phone")}</dt>
            <dd className="num text-[13px]">{me?.phone ?? <span className="text-hint">{t("profile.noPhone")}</span>}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="eyebrow">{t("profile.id")}</dt>
            <dd className="num text-[13px]">{me?.id ?? "—"}</dd>
          </div>
          {me?.createdAt ? (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="eyebrow">{t("profile.since")}</dt>
              <dd className="num text-[13px]">{new Date(me.createdAt).toLocaleDateString()}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="rise card px-5 py-5" style={{ "--i": 1 } as React.CSSProperties}>
        <div className="eyebrow mb-3">{t("profile.language")}</div>
        <div className="flex gap-2">
          {LOCALES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                haptic.select();
                setLocale(option.value);
              }}
              className={`btn flex-1 ${locale === option.value ? "btn-primary" : "btn-ghost"}`}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </section>

      {me ? null : <EmptyState text={t("app.outsideTelegram")} />}
    </Screen>
  );
};
