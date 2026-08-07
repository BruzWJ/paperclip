import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { InlineBanner } from "./InlineBanner";
import { Button } from "./ui/button";
import {
  RuntimeAgentConfigurationFields,
  type RuntimeAgentConfigurationValues,
} from "./RuntimeAgentConfigurationFields";

function completeGrantMap<Key extends string>(
  keys: readonly Key[],
  values: Partial<Record<Key, boolean>>,
): Record<Key, boolean> {
  return Object.fromEntries(
    keys.map((key) => [key, values[key] === true]),
  ) as Record<Key, boolean>;
}

export function AgentRuntimeGrantsSection({
  agentId,
  companyId,
}: {
  agentId: string;
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = [
    "agents",
    agentId,
    "runtime-configuration",
    companyId ?? null,
  ] as const;
  const configuration = useQuery({
    queryKey,
    queryFn: () => agentsApi.getRuntimeConfiguration(agentId, companyId),
  });
  const update = useMutation({
    mutationFn: (value: RuntimeAgentConfigurationValues) =>
      agentsApi.updateRuntimeConfiguration(
        agentId,
        {
          contextGrants: value.contextGrants,
          actionGrants: value.actionGrants,
          mentionReachGrants: value.mentionReachGrants,
        },
        companyId,
      ),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(queryKey, snapshot);
    },
  });

  const value = useMemo<RuntimeAgentConfigurationValues | null>(() => {
    const snapshot = configuration.data;
    if (!snapshot) return null;
    return {
      contextGrants: completeGrantMap<AgentContextGrantKey>(
        AGENT_CONTEXT_GRANT_KEYS,
        snapshot.contextGrants,
      ),
      actionGrants: completeGrantMap<PaperclipActionKey>(
        PAPERCLIP_ACTION_KEYS,
        snapshot.actionGrants,
      ),
      mentionReachGrants: completeGrantMap<AgentMentionReachGrantKey>(
        AGENT_MENTION_REACH_GRANT_KEYS,
        snapshot.mentionReachGrants,
      ),
    };
  }, [configuration.data]);

  return (
    <div className="space-y-4">
      {configuration.isError ? (
        <InlineBanner
          tone="danger"
          title="Runtime access could not be loaded"
        >
          {configuration.error instanceof Error
            ? configuration.error.message
            : "Unknown error"}
        </InlineBanner>
      ) : null}
      {update.isError ? (
        <InlineBanner
          tone="danger"
          title="Runtime access could not be saved"
        >
          {update.error instanceof Error ? update.error.message : "Unknown error"}
        </InlineBanner>
      ) : null}
      {update.isPending ? (
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          Saving runtime access…
        </p>
      ) : null}
      {value ? (
        <RuntimeAgentConfigurationFields
          value={value}
          onChange={(next) => update.mutate(next)}
          disabled={update.isPending}
        />
      ) : configuration.isLoading ? (
        <p className="text-xs text-muted-foreground">
          Loading explicit grants…
        </p>
      ) : !configuration.isError ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            No data is available for this agent&apos;s runtime access.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void configuration.refetch()}
            disabled={configuration.isFetching}
          >
            {configuration.isFetching ? "Refreshing runtime access…" : "Refresh runtime access"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
