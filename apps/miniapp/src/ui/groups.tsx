import type { EventGroup, Group } from "../api";
import { useI18n } from "../i18n";
import { Chip } from "./primitives";

/**
 * Groups are Telegram chats: the title comes from Telegram, and membership is
 * managed there rather than here.
 */
export const GroupChips = ({ groups }: { groups: readonly EventGroup[] }) =>
  groups.length === 0 ? null : (
    <>
      {groups.map((group) => (
        <Chip key={group.id} tone="soft">
          {group.title}
        </Chip>
      ))}
    </>
  );

export const GroupPicker = ({
  available,
  value,
  disabled = false,
  onChange,
}: {
  available: readonly Group[];
  value: readonly number[];
  disabled?: boolean;
  onChange: (groups: number[]) => void;
}) => {
  const { t } = useI18n();

  if (available.length === 0) return <p className="text-[12px] text-hint">{t("admin.noGroups")}</p>;

  // `problem` carries Telegram's own words — far more useful than "something went wrong".
  const broken = available.filter((group) => group.problem !== null);

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {available.map((group) => {
          const active = value.includes(group.id);
          return (
            <button
              key={group.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(active ? value.filter((id) => id !== group.id) : [...value, group.id])}
              className={`chip ${active ? "chip-flare" : ""} transition-transform active:scale-95 disabled:opacity-50`}
              style={group.problem === null ? undefined : { borderColor: "var(--danger)", color: "var(--danger)" }}
            >
              {group.problem === null ? (group.title ?? group.id) : `⚠ ${group.title ?? group.id}`}
            </button>
          );
        })}
      </div>
      {broken.length > 0 ? (
        <div className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--danger)" }}>
          <p>{t("admin.groupsUnreachable")}</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {broken.map((group) => (
              <li key={group.id} className="num break-all">
                {group.id}: {group.problem}
                {group.movedTo === null ? null : ` → ${t("admin.groupMovedTo", { id: group.movedTo })}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
};
