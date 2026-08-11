import { useI18n } from "../i18n";
import { Chip } from "./primitives";

/**
 * Group names come from the server's EVENT_GROUPS catalog, so they are opaque
 * strings rather than translatable keys — they render verbatim in both locales.
 */
export const GroupChips = ({ groups }: { groups: readonly string[] }) =>
  groups.length === 0 ? null : (
    <>
      {groups.map((group) => (
        <Chip key={group} tone="soft">
          {group}
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
  available: readonly string[];
  value: readonly string[];
  disabled?: boolean;
  onChange: (groups: string[]) => void;
}) => {
  const { t } = useI18n();

  if (available.length === 0) return <p className="text-[12px] text-hint">{t("admin.noGroups")}</p>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {available.map((group) => {
        const active = value.includes(group);
        return (
          <button
            key={group}
            type="button"
            disabled={disabled}
            onClick={() => onChange(active ? value.filter((name) => name !== group) : [...value, group])}
            className={`chip ${active ? "chip-flare" : ""} transition-transform active:scale-95 disabled:opacity-50`}
          >
            {group}
          </button>
        );
      })}
    </div>
  );
};
