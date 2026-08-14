import { useState } from "react";
import { AGENT_ICON_NAMES, type AgentIconName } from "@paperclipai/shared";
import * as PopoverUI from "@/components/ui/popover";
import * as CommandUI from "@/components/ui/command";
import { cn } from "@/lib/utils";
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
  children: React.ReactNode;
}

export function AgentIconPicker({ value, onChange, children }: AgentIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  return (
    <PopoverUI.Popover open={open} onOpenChange={setOpen}>
      <PopoverUI.PopoverTrigger asChild>{children}</PopoverUI.PopoverTrigger>
      <PopoverUI.PopoverContent className="w-72 p-0" align="start">
        <CommandUI.Command>
          <CommandUI.CommandInput
            placeholder="Search icons..."
            value={search}
            onValueChange={setSearch}
            autoFocus
          />
          <CommandUI.CommandList className="max-h-48">
            <CommandUI.CommandEmpty>No icons match</CommandUI.CommandEmpty>
            <CommandUI.CommandGroup className="[&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:grid-cols-7 [&_[cmdk-group-items]]:gap-1">
              {AGENT_ICON_NAMES.map((name) => {
                const Icon = AGENT_ICONS[name];
                return (
                  <CommandUI.CommandItem
                    key={name}
                    value={name}
                    aria-label={name}
                    onSelect={() => {
                      onChange(name);
                      setOpen(false);
                      setSearch("");
                    }}
                    className={cn(
                      "size-8 justify-center p-0",
                      (value ?? DEFAULT_ICON) === name && "bg-accent ring-1 ring-primary",
                    )}
                    title={name}
                  >
                    <Icon className="size-4" />
                  </CommandUI.CommandItem>
                );
              })}
            </CommandUI.CommandGroup>
          </CommandUI.CommandList>
        </CommandUI.Command>
      </PopoverUI.PopoverContent>
    </PopoverUI.Popover>
  );
}
