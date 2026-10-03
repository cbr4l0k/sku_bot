import { useCallback, useState } from "react";

import { CITIES, type CitySlug, type CityRole } from "@sku/cities";

import { sku, type PersonCard } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { errorText, fullName, initials, monthYear, percent } from "../lib/format";
import { useAction, useResource } from "../lib/useResource";
import { useSession } from "../session";
import { haptic } from "../telegram";
import { Sheet, SheetFooter, useConfirm, useToast } from "./overlays";
import { Button, ErrorState, Loader, TelegramUsername } from "./primitives";

const ROLES: ReadonlyArray<{ role: CityRole | null; key: MessageKey }> = [
  { role: null, key: "role.none" },
  { role: "organizer", key: "role.organizer" },
  { role: "admin", key: "role.admin" },
];

/**
 * One person, as an admin sees them: what they do in the club, and a role per
 * branch. Roles are edited as a draft and saved together — the server takes
 * all of them or none.
 */
export const PersonSheet = ({ userId, onClose, onChanged }: { userId: number; onClose: () => void; onChanged: () => void }) => {
  const { t } = useI18n();
  const card = useResource(useCallback(() => sku.person(userId), [userId]));
  return (
    <Sheet title={card.data ? fullName(card.data) : t("people.title")} onClose={onClose} full>
      {card.data ? (
        <Card card={card.data} onSaved={() => void card.reload(true).then(onChanged)} />
      ) : card.loading ? (
        <Loader label={t("common.loading")} />
      ) : (
        <ErrorState message={errorText(t, card.error)} retryLabel={t("common.retry")} onRetry={() => void card.reload()} />
      )}
    </Sheet>
  );
};

const Card = ({ card, onSaved }: { card: PersonCard; onSaved: () => void }) => {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const action = useAction();
  const [roles, setRoles] = useState<Record<CitySlug, CityRole | null>>(
    () => Object.fromEntries(card.roles.map((entry) => [entry.city, entry.role])) as Record<CitySlug, CityRole | null>,
  );
  const changed = card.roles.filter((entry) => roles[entry.city] !== entry.role);
  // A branch with nothing grantable is somebody else's to decide; it is shown, not offered.
  const editable = card.roles.filter((entry) => entry.grantable.length > 0);

  const run = (task: () => Promise<unknown>, done: string) =>
    void action.run(
      async () => {
        await task();
        toast(done);
        onSaved();
      },
      { onError: (error) => toast(errorText(t, error), "err") },
    );

  const save = () => run(() => sku.setCityRoles(card.id, changed.map((entry) => ({ city: entry.city, role: roles[entry.city] }))), t("toast.roleSaved"));

  const toggleBlock = async () => {
    if (!(await confirm({ text: t(card.isBanned ? "admin.confirmUnban" : "admin.confirmBan"), danger: !card.isBanned }))) return;
    run(() => (card.isBanned ? sku.unban(card.id) : sku.ban(card.id)), t("common.saved"));
  };

  const since = card.joinedAt ? t("profile.sinceLine", { since: monthYear(card.joinedAt, locale) }) : null;

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        <span className="av h-11 w-11 text-[14px]">{initials(card)}</span>
        <div className="min-w-0">
          <h2 className="display text-[16px] break-words">{fullName(card)}</h2>
          <div className="num flex flex-wrap gap-x-1.5 text-[11px] text-hint">
            {card.username ? <TelegramUsername username={card.username} /> : null}
            {since ? <span>{card.username ? `· ${since}` : since}</span> : null}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Tile label={t("people.signUps")} value={String(card.stats.signUps)} />
        <Tile label={t("profile.turnout")} value={card.stats.turnout === null ? "—" : percent(card.stats.turnout)} />
        <Tile label={t("people.led")} value={String(card.stats.led)} />
      </div>

      <div className="eyebrow mt-1.5">{t("people.roleByBranch")}</div>
      <div className="card bg-white">
        {card.roles.map((entry) => (
          <div key={entry.city} className="row block">
            <div className="mb-2 text-[14px] font-semibold">{CITIES[entry.city].name[locale]}</div>
            <div className="seg" role="radiogroup" aria-label={CITIES[entry.city].name[locale]}>
              {ROLES.map((option) => {
                const allowed = option.role === entry.role || entry.grantable.includes(option.role);
                return (
                  <button
                    key={option.role ?? "none"}
                    type="button"
                    role="radio"
                    aria-checked={roles[entry.city] === option.role}
                    className="tab disabled:opacity-40"
                    data-active={roles[entry.city] === option.role}
                    disabled={!allowed || action.pending}
                    onClick={() => {
                      haptic.select();
                      setRoles((current) => ({ ...current, [entry.city]: option.role }));
                    }}
                  >
                    {t(option.key)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-hint">{t(editable.length ? "people.rolesHint" : "people.rolesReadOnly")}</p>

      <div className="card bg-white">
        <div className="row">
          <span className="eyebrow w-[78px] shrink-0 text-[9px]">{t("profile.phone")}</span>
          <span className="num flex-1 text-[13px]">{card.phone ?? <span className="text-hint">{t("people.noPhone")}</span>}</span>
        </div>
        {me?.isAdmin && card.id !== me.id ? (
          <div className="row">
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">{t("people.clubAdmin")}</span>
              <span className="block text-[12px] text-hint">{card.isConfiguredAdmin ? t("admin.configuredAdmin") : t("people.clubAdminHint")}</span>
            </span>
            <button
              type="button"
              className="switch"
              aria-pressed={card.isAdmin}
              aria-label={t("people.clubAdmin")}
              disabled={card.isConfiguredAdmin || action.pending}
              onClick={() => run(() => (card.isAdmin ? sku.demote(card.id) : sku.promote(card.id)), t("common.saved"))}
            >
              <span />
            </button>
          </div>
        ) : null}
      </div>

      <SheetFooter>
        <div className={`grid gap-2 ${card.canBlock ? "grid-cols-2" : "grid-cols-1"}`}>
          {card.canBlock ? (
            <Button variant={card.isBanned ? "ghost" : "danger"} loading={action.pending} onClick={() => void toggleBlock()}>
              {t(card.isBanned ? "admin.unban" : "people.block")}
            </Button>
          ) : null}
          <Button loading={action.pending} disabled={changed.length === 0} onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </SheetFooter>
    </div>
  );
};

const Tile = ({ label, value }: { label: string; value: string }) => (
  <div className="stattile px-3.5 py-3">
    <div className="eyebrow mb-1">{label}</div>
    <div className="display text-[22px]">{value}</div>
  </div>
);
