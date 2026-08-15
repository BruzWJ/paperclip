import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useQuery } from "@tanstack/react-query";
import type { Goal, GoalLevel, GoalStatus } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { goalsApi } from "@/api/goals";
import { queryKeys } from "@/lib/queryKeys";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { formatDate } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
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

function label(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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

  const ownerAgent = goal.ownerAgentId ? agents?.find((a) => a.id === goal.ownerAgentId) : null;

  const parentGoal = goal.parentId ? allGoals?.find((g) => g.id === goal.parentId) : null;

  return (
    <div className="space-y-4">
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel>Status</FieldLabel>
          <FieldContent>
            {onUpdate ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-auto p-0 hover:bg-transparent hover:opacity-80"
                  >
                    <DomainStatus status={goal.status} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-40" align="end">
                  <DropdownMenuRadioGroup
                    value={goal.status}
                    onValueChange={(status) => onUpdate({ status })}
                  >
                    {GOAL_STATUSES.map((status) => (
                      <DropdownMenuRadioItem key={status} value={status} className="text-xs">
                        {label(status)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <DomainStatus status={goal.status} />
            )}
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel>Level</FieldLabel>
          <FieldContent>
            {onUpdate ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-auto p-0 hover:bg-transparent hover:opacity-80"
                  >
                    <span className="text-sm capitalize">{goal.level}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-40" align="end">
                  <DropdownMenuRadioGroup value={goal.level} onValueChange={(level) => onUpdate({ level })}>
                    {GOAL_LEVELS.map((level) => (
                      <DropdownMenuRadioItem key={level} value={level} className="text-xs">
                        {label(level)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="text-sm capitalize">{goal.level}</span>
            )}
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel>Owner</FieldLabel>
          <FieldContent>
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
          </FieldContent>
        </Field>

        {goal.parentId && (
          <Field orientation="horizontal">
            <FieldLabel>Parent goal</FieldLabel>
            <FieldContent>
              <Link
                to="/$companyId/goals/$goalId"
                params={{ companyId, goalId: goal.parentId }}
                className="text-sm hover:underline"
              >
                {parentGoal?.title ?? goal.parentId.slice(0, 8)}
              </Link>
            </FieldContent>
          </Field>
        )}
      </FieldGroup>

      <Separator />

      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel>Created</FieldLabel>
          <FieldContent>
            <span className="text-sm">{formatDate(goal.createdAt)}</span>
          </FieldContent>
        </Field>
        <Field orientation="horizontal">
          <FieldLabel>Updated</FieldLabel>
          <FieldContent>
            <span className="text-sm">{formatDate(goal.updatedAt)}</span>
          </FieldContent>
        </Field>
      </FieldGroup>
    </div>
  );
}
