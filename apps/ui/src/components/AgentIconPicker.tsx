import { AGENT_ICON_NAMES, type AgentIconName } from "@paperclipai/shared";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { AGENT_ICONS, getAgentIcon } from "../lib/agent-icons";

const DEFAULT_ICON: AgentIconName = "bot";

interface AgentIconProps {
  icon: string | null | undefined;
  className?: string;
}

export function AgentIcon({ icon, className }: AgentIconProps) {
  const Icon = getAgentIcon(icon);
  return <Icon className={className} />;
}

interface AgentIconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string) => void;
}

const iconOptions = AGENT_ICON_NAMES.map((name) => ({
  id: name,
  label: name,
}));

export function AgentIconPicker({ value, onChange }: AgentIconPickerProps) {
  const selectedValue = value ?? DEFAULT_ICON;
  const SelectedIcon = AGENT_ICONS[selectedValue as AgentIconName] ?? AGENT_ICONS[DEFAULT_ICON];
  return (
    <EntityCombobox
      value={selectedValue}
      options={iconOptions}
      type="icon"
      ariaLabel="Change agent icon"
      placeholder="Choose icon"
      noneLabel="Choose icon"
      includeNone={false}
      openOnFocus={false}
      onValueChange={onChange}
      searchPlaceholder="Search icons..."
      emptyMessage="No icons match"
      triggerProps={{ variant: "secondary", size: "icon-lg" }}
      contentClassName="!w-72"
      listClassName="max-h-48 [&_[cmdk-empty]]:col-span-7 [&_[cmdk-list-sizer]]:grid [&_[cmdk-list-sizer]]:grid-cols-7 [&_[cmdk-list-sizer]]:gap-1 [&_[cmdk-list-sizer]]:p-1"
      showTriggerIndicator={false}
      showSelectionIndicator={false}
      getOptionClassName={(option) =>
        `size-8 justify-center p-0 ${selectedValue === option.id ? "bg-accent ring-1 ring-primary" : ""}`
      }
      renderValue={() => <SelectedIcon />}
      renderOption={(option) => {
        const Icon = AGENT_ICONS[option.id as AgentIconName];
        return (
          <>
            <Icon className="size-4" aria-hidden="true" />
            <span className="sr-only">{option.label}</span>
          </>
        );
      }}
    />
  );
}
