import { AGENT_CONTEXT_GRANT_KEYS, type AgentContextGrantKey } from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel } from "@/components/ui/field";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const TIER_LABELS = ["Current task", "Sub-tasks", "Company tasks"] as const;
const DEPTH_LABELS = ["Content", "Comments", "Agent runs"] as const;

const CELL_DESCRIPTIONS: Record<AgentContextGrantKey, string> = {
  carry_context: "Resume the current task's eligible native session; otherwise start fresh.",
  read_task_comments: "Read the current task's chronological thread.",
  read_task_agent_run: "Inspect runs referenced by the current task.",
  list_sub_tasks: "List tasks beneath the active task with their content.",
  read_sub_task_comments: "Read comments on tasks beneath the active task.",
  read_sub_task_agent_run: "Inspect runs on tasks beneath the active task.",
  list_company_tasks: "List same-company tasks with their content.",
  read_company_task_comments: "Read comments on same-company tasks.",
  read_company_task_agent_run: "Inspect runs on same-company tasks.",
};

const MATRIX_ROWS = TIER_LABELS.map((tier, tierIndex) => ({
  tier,
  cells: DEPTH_LABELS.map((depth, depthIndex) => ({
    depth,
    key: AGENT_CONTEXT_GRANT_KEYS[tierIndex * DEPTH_LABELS.length + depthIndex]!,
  })),
}));

export function ContextAccessMatrix({
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
      <Table className="table-fixed">
        <TableCaption className="text-left text-xs">{description}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Context access</TableHead>
            {DEPTH_LABELS.map((depth) => (
              <TableHead key={depth} className="text-center">
                {depth}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {MATRIX_ROWS.map(({ tier, cells }) => (
            <TableRow key={tier}>
              <TableCell className="font-medium">{tier}</TableCell>
              {cells.map(({ depth, key }) => {
                const enabled = value[key];
                const label = `${tier} ${depth}: ${enabled ? enabledLabel : disabledLabel}`;
                return (
                  <TableCell key={key} className="p-0 text-center">
                    <FieldLabel
                      className={cn(
                        "flex min-h-9 w-full items-center justify-center p-2",
                        !disabled && "cursor-pointer",
                      )}
                      title={`${label}. ${CELL_DESCRIPTIONS[key]}`}
                    >
                      <Checkbox
                        checked={enabled}
                        disabled={disabled}
                        aria-label={label}
                        onCheckedChange={(checked) => onCellChange?.(key, checked === true)}
                      />
                    </FieldLabel>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
