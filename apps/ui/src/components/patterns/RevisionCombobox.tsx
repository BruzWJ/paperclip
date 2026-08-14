import { Badge } from "@/components/ui/badge";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import type { EntityOption } from "@/lib/entity-selector";

export interface RevisionComboboxProps {
  label: string;
  onValueChange: (value: string) => void;
  options: EntityOption[];
  side: "old" | "new";
  value: string;
}

/** Shared revision selector backed by the Kibo entity combobox pattern. */
export function RevisionCombobox({ label, onValueChange, options, side, value }: RevisionComboboxProps) {
  const triggerId = `revision-${side}-${label.toLowerCase().replaceAll(" ", "-")}`;

  return (
    <LabeledFormField
      orientation="horizontal"
      className="w-auto gap-2"
      label={<Badge variant={side === "old" ? "outline" : "secondary"}>{label}</Badge>}
      labelFor={triggerId}
    >
      <EntityCombobox
        value={value}
        options={options}
        onValueChange={onValueChange}
        type="revision"
        ariaLabel={`Select ${label.toLowerCase()} revision`}
        placeholder="Select revision"
        noneLabel="No revision"
        includeNone={false}
        triggerClassName="h-8 min-w-(--sz-12rem) px-2 text-xs"
        triggerProps={{ id: triggerId }}
      />
    </LabeledFormField>
  );
}
