import {
  AGENT_CONTEXT_GRANT_KEYS,
  type AgentContextGrantKey,
} from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

const TIER_LABELS = ["Current issue", "Sub-issues", "Company issues"] as const;
const DEPTH_LABELS = ["Content", "Comments", "Agent runs"] as const;

const CELL_DESCRIPTIONS: Record<AgentContextGrantKey, string> = {
  carry_context:
    "Resume the current issue's eligible native session; otherwise start fresh.",
  read_issue_comments: "Read the current issue's chronological thread.",
  read_issue_agent_run: "Inspect runs referenced by the current issue.",
  list_sub_issues: "List issues beneath the active issue with their content.",
  read_sub_issue_comments: "Read comments on issues beneath the active issue.",
  read_sub_issue_agent_run: "Inspect runs on issues beneath the active issue.",
  list_company_issues: "List same-company issues with their content.",
  read_company_issue_comments: "Read comments on same-company issues.",
  read_company_issue_agent_run: "Inspect runs on same-company issues.",
};

const MATRIX_ROWS = TIER_LABELS.map((tier, tierIndex) => ({
  tier,
  cells: DEPTH_LABELS.map((depth, depthIndex) => ({
    depth,
    key: AGENT_CONTEXT_GRANT_KEYS[
      tierIndex * DEPTH_LABELS.length + depthIndex
    ]!,
  })),
}));

export function AttentionMatrix({
  value,
  onCellChange,
  disabled = false,
  enabledLabel,
  disabledLabel,
  description,
  className,
  testId,
}: {
  value: Record<AgentContextGrantKey, boolean>;
  onCellChange?: (key: AgentContextGrantKey, enabled: boolean) => void;
  disabled?: boolean;
  enabledLabel: string;
  disabledLabel: string;
  description: string;
  className?: string;
  testId: string;
}) {
  return (
    <div className={cn("space-y-2", className)} data-testid={testId}>
      <div className="grid grid-cols-4 gap-1 text-xs">
        <div className="px-2 py-1 text-muted-foreground">Attention</div>
        {DEPTH_LABELS.map((depth) => (
          <div
            key={depth}
            className="px-2 py-1 text-center font-medium text-muted-foreground"
          >
            {depth}
          </div>
        ))}
        {MATRIX_ROWS.flatMap(({ tier, cells }) => [
          <div
            key={`${tier}:label`}
            className="flex items-center rounded-md bg-muted/40 px-2 py-2 font-medium"
          >
            {tier}
          </div>,
          ...cells.map(({ depth, key }) => {
            const enabled = value[key];
            const label = `${tier} ${depth}: ${enabled ? enabledLabel : disabledLabel}`;
            return (
              <label
                key={key}
                className={cn(
                  "flex min-h-9 items-center justify-center rounded-md border border-border px-2 py-1.5",
                  !enabled && "bg-muted/60 text-muted-foreground",
                  !disabled && "cursor-pointer hover:bg-accent/40",
                )}
                title={`${label}. ${CELL_DESCRIPTIONS[key]}`}
              >
                <Checkbox
                  checked={enabled}
                  disabled={disabled}
                  aria-label={label}
                  onCheckedChange={(checked) =>
                    onCellChange?.(key, checked === true)
                  }
                />
              </label>
            );
          }),
        ])}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
