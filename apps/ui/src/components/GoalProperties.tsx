
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery } from "@tanstack/react-query";
import type { Goal, GoalLevel, GoalStatus } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";
import { formatDate } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const satisfies readonly GoalStatus[];
const GOAL_LEVELS = ["company", "team", "agent", "task"] as const satisfies readonly GoalLevel[];

interface GoalPropertiesProps {
  goal: Goal;
  onUpdate?: (data: Record<string, unknown>) => void;
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function PickerButton({
  current,
  options,
  onChange,
  children,
}: {
  current: string;
  options: readonly string[];
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="cursor-pointer hover:opacity-80 transition-opacity">
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-40" align="end">
        <DropdownMenuRadioGroup value={current} onValueChange={onChange}>
          {options.map((opt) => (
            <DropdownMenuRadioItem key={opt} value={opt} className="text-xs">
              {label(opt)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function GoalProperties({ goal, onUpdate }: GoalPropertiesProps) {
  const companyId = useCompanyRouteId();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
  });

  const ownerAgent = goal.ownerAgentId
    ? agents?.find((a) => a.id === goal.ownerAgentId)
    : null;

  const parentGoal = goal.parentId
    ? allGoals?.find((g) => g.id === goal.parentId)
    : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          {onUpdate ? (
            <PickerButton
              current={goal.status}
              options={GOAL_STATUSES}
              onChange={(status) => onUpdate({ status })}
            >
              <StatusBadge status={goal.status} />
            </PickerButton>
          ) : (
            <StatusBadge status={goal.status} />
          )}
        </PropertyRow>

        <PropertyRow label="Level">
          {onUpdate ? (
            <PickerButton
              current={goal.level}
              options={GOAL_LEVELS}
              onChange={(level) => onUpdate({ level })}
            >
              <span className="text-sm capitalize">{goal.level}</span>
            </PickerButton>
          ) : (
            <span className="text-sm capitalize">{goal.level}</span>
          )}
        </PropertyRow>

        <PropertyRow label="Owner">
          {ownerAgent ? (
            <Link
              to="/$companyId/agents/$agentId"
              params={{ companyId, agentId: ownerAgent.id }}
              className="text-sm hover:underline"
            >
              {ownerAgent.name}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        {goal.parentId && (
          <PropertyRow label="Parent Goal">
            <Link
              to="/$companyId/goals/$goalId"
              params={{ companyId, goalId: goal.parentId }}
              className="text-sm hover:underline"
            >
              {parentGoal?.title ?? goal.parentId.slice(0, 8)}
            </Link>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(goal.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{formatDate(goal.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
