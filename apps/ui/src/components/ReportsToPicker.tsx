import type { Agent } from "@paperclipai/shared";
import * as Menu from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { User } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";

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

  return (
    <Menu.DropdownMenu>
      <Menu.DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-auto max-w-full min-w-0 justify-start overflow-hidden py-1"
          aria-invalid={terminatedManager || unknownManager || undefined}
          disabled={disabled}
        >
          {unknownManager ? (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
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
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{disabled ? disabledEmptyLabel : chooseLabel}</span>
            </>
          )}
        </Button>
      </Menu.DropdownMenuTrigger>
      <Menu.DropdownMenuContent className="w-48" align="start">
        {terminatedManager && (
          <>
            <Menu.DropdownMenuLabel className="flex min-w-0 items-center gap-2 overflow-hidden text-xs font-normal text-muted-foreground">
              <AgentIcon icon={current.icon} className="shrink-0 h-3 w-3" />
              <span className="min-w-0 truncate">Current: {current.name} (terminated)</span>
            </Menu.DropdownMenuLabel>
            <Menu.DropdownMenuSeparator />
          </>
        )}
        {unknownManager && (
          <>
            <Menu.DropdownMenuLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
              Saved manager is missing from this company. Choose a new manager or clear.
            </Menu.DropdownMenuLabel>
            <Menu.DropdownMenuSeparator />
          </>
        )}
        <Menu.DropdownMenuRadioGroup
          value={value ?? "none"}
          onValueChange={(id) => onChange(id === "none" ? null : id)}
        >
          <Menu.DropdownMenuRadioItem value="none" className="text-xs">
            No manager
          </Menu.DropdownMenuRadioItem>
          {rows.map((agent) => (
            <Menu.DropdownMenuRadioItem
              key={agent.id}
              value={agent.id}
              className="min-w-0 overflow-hidden text-xs"
            >
              <AgentIcon icon={agent.icon} className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{agent.name}</span>
              {agent.title ? (
                <span className="ml-auto shrink-0 text-muted-foreground">{agent.title}</span>
              ) : null}
            </Menu.DropdownMenuRadioItem>
          ))}
        </Menu.DropdownMenuRadioGroup>
      </Menu.DropdownMenuContent>
    </Menu.DropdownMenu>
  );
}
