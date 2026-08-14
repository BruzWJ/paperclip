import type { Goal } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { statusBadgeVariant } from "../lib/status-variant";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import * as Collapse from "@/components/ui/collapsible";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Item, ItemGroup } from "@/components/ui/item";

interface GoalTreeProps {
  goals: Goal[];
  linkGoals?: boolean;
  onSelect?: (goal: Goal) => void;
}

interface GoalNodeProps {
  goal: Goal;
  allGoals: Goal[];
  depth: number;
  linkGoals?: boolean;
  onSelect?: (goal: Goal) => void;
}

function GoalNode({ goal, allGoals, depth, linkGoals, onSelect }: GoalNodeProps) {
  const companyId = useCompanyRouteId();
  const [expanded, setExpanded] = useState(true);
  const children = allGoals.filter((item) => item.parentId === goal.id);
  const hasChildren = children.length > 0;

  const treeToggle = hasChildren ? (
    <Collapse.CollapsibleTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-4 shrink-0"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${goal.title} subtree`}
      >
        <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
      </Button>
    </Collapse.CollapsibleTrigger>
  ) : (
    <span className="w-4 shrink-0" />
  );

  const goalContent = (
    <>
      <span className="text-xs text-muted-foreground capitalize">{goal.level}</span>
      <span className="min-w-0 flex-1 truncate">{goal.title}</span>
      <Badge variant={statusBadgeVariant(goal.status)}>{goal.status.replace(/[_-]/g, " ")}</Badge>
    </>
  );

  const interactiveContentClasses =
    "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const rowContent = linkGoals ? (
    <Link
      to="/$companyId/goals/$goalId"
      params={{ companyId, goalId: goal.id }}
      className={cn(interactiveContentClasses, "no-underline text-inherit")}
    >
      {goalContent}
    </Link>
  ) : onSelect ? (
    <Button
      type="button"
      variant="ghost"
      className={cn(interactiveContentClasses, "h-auto p-0")}
      onClick={() => onSelect(goal)}
    >
      {goalContent}
    </Button>
  ) : (
    <div className="flex min-w-0 flex-1 items-center gap-2">{goalContent}</div>
  );

  return (
    <Collapse.Collapsible open={expanded} onOpenChange={setExpanded} role="listitem">
      <Item
        size="sm"
        className="flex-nowrap gap-2 rounded-none border-0 px-3 py-1.5"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {treeToggle}
        {rowContent}
      </Item>
      {hasChildren ? (
        <Collapse.CollapsibleContent>
          <ItemGroup>
            {children.map((child) => (
              <GoalNode
                key={child.id}
                goal={child}
                allGoals={allGoals}
                depth={depth + 1}
                linkGoals={linkGoals}
                onSelect={onSelect}
              />
            ))}
          </ItemGroup>
        </Collapse.CollapsibleContent>
      ) : null}
    </Collapse.Collapsible>
  );
}

export function GoalTree({ goals, linkGoals, onSelect }: GoalTreeProps) {
  const goalIds = new Set(goals.map((g) => g.id));
  const roots = goals.filter((g) => !g.parentId || !goalIds.has(g.parentId));

  if (goals.length === 0) {
    return (
      <Empty className="border-0 p-4 md:p-4">
        <EmptyDescription>No goals.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <ItemGroup className="overflow-hidden rounded-md border py-1">
      {roots.map((goal) => (
        <GoalNode
          key={goal.id}
          goal={goal}
          allGoals={goals}
          depth={0}
          linkGoals={linkGoals}
          onSelect={onSelect}
        />
      ))}
    </ItemGroup>
  );
}
