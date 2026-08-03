import { useMemo, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  supportedEnvironmentDriversForAdapter,
  type AgentAdapterType,
  type JoinRequestType,
} from "@paperclipai/shared";
import { environmentsApi } from "@/api/environments";
import { queryKeys } from "@/lib/queryKeys";
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
  const environmentsQuery = useQuery({
    queryKey: queryKeys.environments.list(companyId),
    queryFn: () => environmentsApi.list(companyId),
    enabled: isAgentRequest,
  });
  const eligibleEnvironments = useMemo(() => {
    if (!isAgentRequest) return [];
    const allowedDrivers = new Set(
      supportedEnvironmentDriversForAdapter(adapterType ?? ""),
    );
    return (environmentsQuery.data ?? []).filter(
      (environment) =>
        environment.status === "active" && allowedDrivers.has(environment.driver),
    );
  }, [adapterType, environmentsQuery.data, isAgentRequest]);
  const environmentRequired = isAgentRequest;
  const approveDisabled =
    isPending ||
    (environmentRequired &&
      (environmentsQuery.isLoading || !defaultEnvironmentId));

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
