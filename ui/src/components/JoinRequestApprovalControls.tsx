import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type AgentAdapterType,
  type JoinRequestType,
} from "@paperclipai/shared";
import { environmentsApi } from "@/api/environments";
import { queryKeys } from "@/lib/queryKeys";
import { useAdapterCatalogSync } from "@/adapters/use-adapter-catalog";
import { Button } from "./ui/button";

export interface JoinRequestApprovalControlsProps {
  companyId: string;
  requestType: JoinRequestType;
  adapterType?: AgentAdapterType | string | null;
  onApprove: (input: { defaultEnvironmentId?: string }) => void;
  onReject: () => void;
  isPending: boolean;
  approveLabel?: string;
  rejectLabel?: string;
  className?: string;
  buttonClassName?: string;
  onClickCapture?: (event: MouseEvent<HTMLDivElement>) => void;
}

/**
 * Board-side join approval is deliberately explicit for agent requests. The
 * selected environment becomes part of the first immutable adapter revision;
 * this control never chooses an instance or company default on the board's
 * behalf.
 */
export function JoinRequestApprovalControls({
  companyId,
  requestType,
  adapterType,
  onApprove,
  onReject,
  isPending,
  approveLabel = "Approve",
  rejectLabel = "Reject",
  className = "flex flex-wrap items-center gap-2",
  buttonClassName,
  onClickCapture,
}: JoinRequestApprovalControlsProps) {
  const [defaultEnvironmentId, setDefaultEnvironmentId] = useState("");
  const isAgentRequest = requestType === "agent";
  const admittedAdapters = useAdapterCatalogSync({ enabled: isAgentRequest });
  const environmentsQuery = useQuery({
    queryKey: queryKeys.environments.list(companyId),
    queryFn: () => environmentsApi.list(companyId),
    enabled: isAgentRequest,
  });
  const eligibleEnvironments = useMemo(() => {
    if (!isAgentRequest) return [];
    const adapter = admittedAdapters.find(
      (candidate) => candidate.type === adapterType,
    );
    const allowedDrivers = new Set(
      adapter?.drivers ?? [],
    );
    return (environmentsQuery.data ?? []).filter(
      (environment) =>
        environment.status === "active" && allowedDrivers.has(environment.driver),
    );
  }, [adapterType, admittedAdapters, environmentsQuery.data, isAgentRequest]);
  useEffect(() => {
    if (!defaultEnvironmentId) return;
    if (eligibleEnvironments.some((environment) => environment.id === defaultEnvironmentId)) {
      return;
    }
    // A catalog refresh can remove a transport while this control remains
    // open. Clear the stale choice instead of submitting it as if it were
    // still ACPX-admitted.
    setDefaultEnvironmentId("");
  }, [defaultEnvironmentId, eligibleEnvironments]);
  const environmentRequired = isAgentRequest;
  const approveDisabled =
    isPending ||
    (environmentRequired &&
      (
        environmentsQuery.isLoading
        || !eligibleEnvironments.some(
          (environment) => environment.id === defaultEnvironmentId,
        )
      ));

  return (
    <div className={className} onClickCapture={onClickCapture}>
      {isAgentRequest ? (
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
          <span>Execution environment</span>
          <select
            aria-label="Execution environment"
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            value={defaultEnvironmentId}
            onChange={(event) => setDefaultEnvironmentId(event.target.value)}
            disabled={isPending || environmentsQuery.isLoading}
          >
            <option value="">
              {environmentsQuery.isLoading
                ? "Loading environments…"
                : eligibleEnvironments.length === 0
                  ? "No compatible active environment"
                  : "Choose an environment"}
            </option>
            {eligibleEnvironments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name} ({environment.driver})
              </option>
            ))}
          </select>
          {environmentsQuery.isLoading ? (
            <span role="status" className="sr-only">Loading eligible environments…</span>
          ) : null}
        </label>
      ) : null}
      <Button
        size="sm"
        className={buttonClassName}
        onClick={() =>
          onApprove(
            defaultEnvironmentId
              ? { defaultEnvironmentId }
              : {},
          )
        }
        disabled={approveDisabled}
      >
        {approveLabel}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        className={buttonClassName}
        onClick={onReject}
        disabled={isPending}
      >
        {rejectLabel}
      </Button>
    </div>
  );
}
