import type { Goal } from "@paperclipai/shared";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { StatusBadge } from "./StatusBadge";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { useState } from "react";

interface GoalTreeProps {
  goals: Goal[];
  linkGoals?: boolean;
  onSelect?: (goal: Goal) => void;
}

interface GoalNodeProps {
  goal: Goal;
  children: Goal[];
  allGoals: Goal[];
  depth: number;
  linkGoals?: boolean;
  onSelect?: (goal: Goal) => void;
}

function GoalNode({ goal, children, allGoals, depth, linkGoals, onSelect }: GoalNodeProps) {
  const companyId = useCompanyRouteId();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = children.length > 0;

  const treeToggle = hasChildren ? (
    <button
      type="button"
      className="shrink-0 rounded-sm p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => setExpanded((current) => !current)}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${goal.title} subtree`}
      aria-expanded={expanded}
    >
      <ChevronRight
        className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
      />
    </button>
  ) : (
    <span className="w-4 shrink-0" />
  );

  const goalContent = (
    <>
      <span className="text-xs text-muted-foreground capitalize">{goal.level}</span>
      <span className="min-w-0 flex-1 truncate">{goal.title}</span>
      <StatusBadge status={goal.status} />
    </>
  );

  const rowClasses = "flex items-center gap-2 px-3 py-1.5 text-sm";
  const interactiveContentClasses =
    "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div>
      {linkGoals ? (
        <div
          className={rowClasses}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
        >
          {treeToggle}
          <Link
            to="/$companyId/goals/$goalId"
            params={{ companyId, goalId: goal.id }}
            className={cn(interactiveContentClasses, "no-underline text-inherit")}
          >
            {goalContent}
          </Link>
        </div>
      ) : (
        <div className={rowClasses} style={{ paddingLeft: `${depth * 16 + 12}px` }}>
          {treeToggle}
          {onSelect ? (
            <button
              type="button"
              className={cn(interactiveContentClasses, "border-0 bg-transparent p-0")}
              onClick={() => onSelect(goal)}
            >
              {goalContent}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {goalContent}
            </div>
          )}
        </div>
      )}
      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <GoalNode
              key={child.id}
              goal={child}
              children={allGoals.filter((g) => g.parentId === child.id)}
              allGoals={allGoals}
              depth={depth + 1}
              linkGoals={linkGoals}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree({ goals, linkGoals, onSelect }: GoalTreeProps) {
  const goalIds = new Set(goals.map((g) => g.id));
  const roots = goals.filter((g) => !g.parentId || !goalIds.has(g.parentId));

  if (goals.length === 0) {
    return <p className="text-sm text-muted-foreground">No goals.</p>;
  }

  return (
    <div className="border border-border py-1">
      {roots.map((goal) => (
        <GoalNode
          key={goal.id}
          goal={goal}
          children={goals.filter((g) => g.parentId === goal.id)}
          allGoals={goals}
          depth={0}
          linkGoals={linkGoals}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
