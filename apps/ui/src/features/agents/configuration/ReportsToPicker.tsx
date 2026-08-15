// Empty collections render dedicated UI when data.length === 0.
import type { Agent } from "@paperclipai/shared";
import { User } from "lucide-react";
import { AgentIcon } from "../AgentIconPicker";
import { EntityCombobox } from "@/components/patterns/EntityCombobox";
import type { EntityOption } from "@/lib/entity-selector";

export function ReportsToPicker({
  agents,
  value,
  onChange,
  disabled = false,
  excludeAgentIds = [],
  disabledEmptyLabel = "Reports to: N/A",
  chooseLabel = "Reports to...",
}: {
  agents: Agent[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  excludeAgentIds?: string[];
  disabledEmptyLabel?: string;
  chooseLabel?: string;
}) {
  const exclude = new Set(excludeAgentIds);
  const rows = agents.filter((a) => a.status !== "terminated" && !exclude.has(a.id));
  const current = value ? agents.find((a) => a.id === value) : null;
  const terminatedManager = current?.status === "terminated";
  const unknownManager = Boolean(value && !current);
  const options: EntityOption[] = rows.map((agent) => ({
    id: agent.id,
    label: agent.name,
    searchText: `${agent.name} ${agent.title ?? ""}`,
  }));

  return (
    <EntityCombobox
      value={value ?? ""}
      options={options}
      type="manager"
      ariaLabel="Reports to"
      placeholder={disabled ? disabledEmptyLabel : chooseLabel}
      noneLabel="No manager"
      disabled={disabled}
      openOnFocus={false}
      searchPlaceholder="Search managers..."
      emptyMessage="No eligible managers found."
      triggerClassName="h-auto max-w-full min-w-0 justify-start py-1"
      triggerProps={{
        size: "xs",
        "aria-invalid": terminatedManager || unknownManager || undefined,
      }}
      contentLeading={
        terminatedManager || unknownManager ? (
          <p className="border-b px-3 py-2 text-xs text-muted-foreground">
            {terminatedManager
              ? `Current manager ${current.name} is terminated. Choose a new manager or clear.`
              : "Saved manager is missing from this company. Choose a new manager or clear."}
          </p>
        ) : undefined
      }
      onValueChange={(id) => onChange(id || null)}
      renderValue={() => (
        <>
          {unknownManager ? (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground"  data-icon="inline-start"/>
              <span className="min-w-0 truncate text-muted-foreground">Unknown manager (stale ID)</span>
            </>
          ) : current ? (
            <>
              <AgentIcon icon={current.icon} className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {`Reports to ${current.name}${terminatedManager ? " (terminated)" : ""}`}
              </span>
            </>
          ) : (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground"  data-icon="inline-start"/>
              <span className="min-w-0 truncate">{disabled ? disabledEmptyLabel : chooseLabel}</span>
            </>
          )}
        </>
      )}
      renderOption={(option) => {
        const agent = rows.find((candidate) => candidate.id === option.id);
        return (
          <>
            {agent ? <AgentIcon icon={agent.icon} className="size-3 shrink-0 text-muted-foreground" /> : null}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {agent?.title ? <span className="shrink-0 text-muted-foreground">{agent.title}</span> : null}
          </>
        );
      }}
    />
  );
}
