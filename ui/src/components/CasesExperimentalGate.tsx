import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Link, Navigate } from "@/lib/router";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Route guard for the experimental Cases feature (PAP-12947). Redirects to the
 * dashboard when `enableCases` is off, mirroring {@link PipelinesExperimentalGate}.
 */
export function CasesExperimentalGate({ children }: { children: ReactNode }) {
  const {
    data: experimentalSettings,
    isError,
    isFetched,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (!isFetched) return null;
  if (isError) {
    return (
      <CasesAvailabilityEmptyState
        retrying={isFetching}
        onRetry={() => void refetch()}
      />
    );
  }
  if (experimentalSettings?.enableCases !== true) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

function CasesAvailabilityEmptyState({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Card role="alert" className="block p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Cases are unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Paperclip could not check whether the Cases feature is enabled. Try again or return to the dashboard.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button type="button" onClick={onRetry} disabled={retrying}>
                {retrying ? "Checking…" : "Try again"}
              </Button>
              <Button asChild type="button" variant="outline">
                <Link to="/dashboard">Return to dashboard</Link>
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
