import type { Goal } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { DomainTree, type DomainTreeNode } from "@/components/patterns/DomainTree";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { cn } from "@/lib/utils";

interface GoalTreeProps {
  goals: Goal[];
  linkGoals?: boolean;
  onSelect?: (goal: Goal) => void;
}

function buildGoalNodes(goals: Goal[]): DomainTreeNode<Goal>[] {
  const goalIds = new Set(goals.map((goal) => goal.id));
  const childrenByParentId = new Map<string, Goal[]>();
  for (const goal of goals) {
    if (!goal.parentId || !goalIds.has(goal.parentId)) continue;
    const siblings = childrenByParentId.get(goal.parentId) ?? [];
    siblings.push(goal);
    childrenByParentId.set(goal.parentId, siblings);
  }

  const mapGoal = (goal: Goal): DomainTreeNode<Goal> => ({
    id: goal.id,
    value: goal,
    children: (childrenByParentId.get(goal.id) ?? []).map(mapGoal),
  });

  return goals.filter((goal) => !goal.parentId || !goalIds.has(goal.parentId)).map(mapGoal);
}

/** Goal hierarchy rendered through the shared Kibo Tree domain adapter. */
export function GoalTree({ goals, linkGoals, onSelect }: GoalTreeProps) {
  const companyId = useCompanyRouteId();
  const nodes = useMemo(() => buildGoalNodes(goals), [goals]);
  const initiallyExpanded = useMemo(
    () =>
      new Set(
        nodes.flatMap(function collect(node): string[] {
          return node.children?.length ? [node.id, ...node.children.flatMap(collect)] : [];
        }),
      ),
    [nodes],
  );
  if (goals.length === 0) {
    return (
      <Empty className="border-0 p-4 md:p-4">
        <EmptyDescription>No goals.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <DomainTree
      nodes={nodes}
      defaultExpandedIds={initiallyExpanded}
      ariaLabel="Goals"
      showIcons={false}
      onActivate={({ value }) => onSelect?.(value)}
      renderLabel={({ node }) => {
        const goal = node.value;
        const content = (
          <>
            <span className="text-xs text-muted-foreground capitalize">{goal.level}</span>
            <span className="min-w-0 flex-1 truncate">{goal.title}</span>
            <DomainStatus status={goal.status} />
          </>
        );
        const classes = "flex min-w-0 flex-1 items-center gap-2 text-left";

        if (linkGoals) {
          return (
            <Link
              to="/$companyId/goals/$goalId"
              params={{ companyId, goalId: goal.id }}
              className={cn(classes, "no-underline text-inherit")}
              onClick={(event) => event.stopPropagation()}
            >
              {content}
            </Link>
          );
        }
        if (onSelect) {
          return (
            <Button
              type="button"
              variant="ghost"
              className={cn(classes, "h-auto p-0")}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(goal);
              }}
            >
              {content}
            </Button>
          );
        }
        return <span className={classes}>{content}</span>;
      }}
    />
  );
}
