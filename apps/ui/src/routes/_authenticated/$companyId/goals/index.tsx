import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { goalsApi } from "@/api/goals";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { useDialogActions } from "@/context/DialogContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { GoalTree } from "@/components/GoalTree";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Target, Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/$companyId/goals/")({
  component: Goals,
});

function Goals() {
  const companyId = useCompanyRouteId();
  const { openNewGoal } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const {
    data: goals,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.goals.list(companyId),
    queryFn: () => goalsApi.list(companyId),
  });

  if (isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {goals && goals.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Target />
            </EmptyMedia>
            <EmptyTitle>No goals yet.</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => openNewGoal()}>
              <Plus />
              Add Goal
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {goals && goals.length > 0 && (
        <>
          <div className="flex items-center justify-start">
            <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
              <Plus data-icon="inline-start" className="h-3.5 w-3.5 mr-1.5" />
              New Goal
            </Button>
          </div>
          <GoalTree goals={goals} linkGoals />
        </>
      )}
    </div>
  );
}
