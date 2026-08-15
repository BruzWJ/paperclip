import { type ReactNode, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/kibo-ui/combobox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export interface FilterMenuOption {
  value: string;
  label: string;
  count?: number;
  icon?: ReactNode;
  swatch?: string;
  searchText?: string;
}

export interface FilterMenuPreset {
  label: string;
  values: string[];
}

interface BaseProps {
  label: string;
  options: FilterMenuOption[];
  /** Values currently selected. */
  selected: string[];
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  triggerClassName?: string;
  contentClassName?: string;
  align?: "start" | "end";
}

interface MultiProps extends BaseProps {
  multi: true;
  onToggle: (value: string) => void;
  onClear: () => void;
  presets?: FilterMenuPreset[];
}

interface SingleProps extends BaseProps {
  multi?: false;
  onSelect: (value: string | undefined) => void;
}

export type SearchFilterMenuProps = MultiProps | SingleProps;

function summarizeTrigger(label: string, selected: string[], options: FilterMenuOption[]): string {
  if (selected.length === 0) return label;
  if (selected.length === 1) {
    const only = options.find((option) => option.value === selected[0]);
    return only ? `${label}: ${only.label}` : label;
  }
  return `${label}: ${selected.length}`;
}

export function SearchFilterMenu(props: SearchFilterMenuProps) {
  const {
    label,
    options,
    selected,
    searchable = false,
    searchPlaceholder = "Search…",
    emptyMessage = "No options",
    triggerClassName,
    contentClassName,
    align = "start",
  } = props;
  const [open, setOpen] = useState(false);

  const active = selected.length > 0;

  function handleOptionClick(value: string) {
    if (props.multi) {
      props.onToggle(value);
      return;
    }
    // Single-select: clicking the selected value clears it, otherwise selects.
    props.onSelect(selected.includes(value) ? undefined : value);
    setOpen(false);
  }

  function applyPreset(preset: FilterMenuPreset) {
    if (!props.multi) return;
    const presetIsActive =
      preset.values.length === selected.length && preset.values.every((value) => selected.includes(value));
    for (const value of options.map((option) => option.value)) {
      const wantSelected = !presetIsActive && preset.values.includes(value);
      if (wantSelected !== selected.includes(value)) props.onToggle(value);
    }
  }

  const activePreset =
    props.multi && props.presets
      ? props.presets.find(
          (preset) =>
            preset.values.length === selected.length &&
            preset.values.every((value) => selected.includes(value)),
        )
      : undefined;

  return (
    <Combobox
      data={options.map((option) => ({ label: option.label, value: option.value }))}
      type={`${label.toLowerCase()} filter`}
      value={selected[0] ?? ""}
      open={open}
      onOpenChange={setOpen}
    >
      <ComboboxTrigger
        variant="outline"
        size="sm"
        className={cn(
          "h-8 gap-1 text-xs font-normal",
          active && "border-primary/60 text-foreground",
          triggerClassName,
        )}
        aria-label={`Filter by ${label}`}
      >
        <span className="truncate">{summarizeTrigger(label, selected, options)}</span>
        {active ? (
          <Badge className="ml-0.5 h-4 min-w-4 px-1 text-(length:--text-nano) tabular-nums">
            {selected.length}
          </Badge>
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        )}
      </ComboboxTrigger>
      <ComboboxContent popoverOptions={{ align, className: cn("!w-64 p-0", contentClassName) }}>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {props.multi && active ? (
            <Button variant="ghost" size="sm" onClick={props.onClear}>
              Clear
            </Button>
          ) : null}
        </div>

        {props.multi && props.presets && props.presets.length > 0 ? (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={1}
            value={activePreset?.label ?? ""}
            onValueChange={(value) => {
              const preset = props.presets?.find(
                (candidate) => candidate.label === (value || activePreset?.label),
              );
              if (preset) applyPreset(preset);
            }}
            className="flex flex-wrap px-3 pb-2"
          >
            {props.presets.map((preset) => (
              <ToggleGroupItem key={preset.label} value={preset.label}>
                {preset.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}

        {searchable ? (
          <ComboboxInput aria-label="Search filter options" placeholder={searchPlaceholder} />
        ) : null}
        <ComboboxList>
          <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
          <ComboboxGroup>
            {options.map((option) => {
              const isSelected = selected.includes(option.value);
              return (
                <ComboboxItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.searchText ?? ""]}
                  onSelect={() => handleOptionClick(option.value)}
                >
                  {props.multi ? (
                    <Checkbox
                      checked={isSelected}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="pointer-events-none"
                    />
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center">
                      {isSelected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                    </span>
                  )}
                  {option.icon ? (
                    <span className="flex h-4 w-4 items-center justify-center">{option.icon}</span>
                  ) : null}
                  {option.swatch ? (
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: option.swatch }}
                      aria-hidden
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm">{option.label}</span>
                  {typeof option.count === "number" ? (
                    <Badge variant="secondary" className="ml-auto tabular-nums">
                      {option.count}
                    </Badge>
                  ) : null}
                </ComboboxItem>
              );
            })}
          </ComboboxGroup>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
