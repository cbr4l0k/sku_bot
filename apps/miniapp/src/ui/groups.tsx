import type { Group } from "../api";
import { useI18n } from "../i18n";
import { Chip } from "./primitives";

/**
 * Groups are Telegram chats: the title comes from Telegram, and membership is
 * managed there rather than here.
 */
export const GroupChips = ({ groups }: { groups: readonly Group[] }) =>
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

  return (
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
          >
            {group.title}
          </button>
        );
      })}
    </div>
  );
};
