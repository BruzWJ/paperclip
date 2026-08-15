// Empty collections render dedicated UI when data.length === 0.
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { AgentConfigForm } from "@/features/agents/configuration/AgentConfigForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FieldDescription, FieldSet } from "@/components/ui/field";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import {
  buildAdapterRevisionConfiguration,
  partitionAgentConfigurationPatch,
} from "@/lib/agent-configuration-control-plane";
import { queryKeys } from "@/lib/queryKeys";
import { formatDate } from "@/lib/utils";
import type { AgentDetail as AgentDetailRecord } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface AgentConfigurationPanelProps {
  agent: AgentDetailRecord;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}

export function AgentConfigurePage({
  agent,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: AgentConfigurationPanelProps) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const [revisionsOpen, setRevisionsOpen] = useState(false);

  const { data: adapterRevisions } = useQuery({
    queryKey: queryKeys.agents.adapterConfigRevisions(agent.id),
    queryFn: () => agentsApi.listAdapterConfigRevisions(agent.id),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <ConfigurationTab
        agent={agent}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        onSavingChange={onSavingChange}
      />
      <Collapsible open={revisionsOpen} onOpenChange={setRevisionsOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost">
            <ChevronDown className={revisionsOpen ? undefined : "-rotate-90"}  data-icon="inline-start"/>
            Immutable adapter revisions
            <Badge variant="secondary">{adapterRevisions?.length ?? 0}</Badge>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          {(adapterRevisions ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This agent has no adapter configuration revision yet.
            </p>
          ) : (
            <ItemGroup className="gap-2">
              {(adapterRevisions ?? []).slice(0, 10).map((revision) => (
                <Item key={revision.id} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>
                      Revision {revision.revisionNumber}
                      {revision.id === agent.currentAdapterConfigRevisionId ? (
                        <Badge variant="outline">Current</Badge>
                      ) : null}
                    </ItemTitle>
                    <ItemDescription>
                      {revision.acpConfiguration.launchProfile.registryName} ·{" "}
                      {formatDate(revision.createdAt)} · Immutable id{" "}
                      <span className="font-mono">{revision.id}</span>
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/* ---- Configuration Tab ---- */

export function ConfigurationTab({
  agent,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: AgentConfigurationPanelProps) {
  const companyId = useCompanyRouteId();
  const queryClient = useQueryClient();
  const [formDirty, setFormDirty] = useState(false);
  const [formSaveAction, setFormSaveAction] = useState<(() => void) | null>(null);
  const [formCancelAction, setFormCancelAction] = useState<(() => void) | null>(null);
  // Stable callback identities: AgentConfigForm re-registers its save/cancel
  // actions whenever these props change, and storing them in state triggers a
  // re-render — fresh inline arrows here would cause an infinite update loop.
  const handleFormSaveActionChange = useCallback((action: (() => void) | null) => {
    setFormSaveAction(() => action);
  }, []);
  const handleFormCancelActionChange = useCallback((action: (() => void) | null) => {
    setFormCancelAction(() => action);
  }, []);
  const [awaitingRefreshAfterSave, setAwaitingRefreshAfterSave] = useState(false);
  const lastAgentRef = useRef(agent);
  const updateConfiguration = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const partitioned = partitionAgentConfigurationPatch(data);
      const runtimeAgentPatch = partitioned.runtimeAgent;
      const operationalPatch = partitioned.operational;
      const hasAdapterRevisionChange = partitioned.hasAdapterRevisionChange;
      const currentAdapterRevision =
        hasAdapterRevisionChange && agent.currentAdapterConfigRevisionId
          ? await agentsApi.getCurrentAdapterConfigRevision(agent.id)
          : null;
      const adapterRevisionConfiguration = hasAdapterRevisionChange
        ? buildAdapterRevisionConfiguration({
            agent,
            currentRevision: currentAdapterRevision,
            patch: data,
          })
        : null;

      if (Object.keys(runtimeAgentPatch).length > 0) {
        const runtimeConfiguration = await agentsApi.updateRuntimeConfiguration(agent.id, runtimeAgentPatch);
        queryClient.setQueryData(
          queryKeys.agents.runtimeConfiguration(agent.id, companyId),
          runtimeConfiguration,
        );
      }

      if (Object.keys(operationalPatch).length > 0) {
        await agentsApi.updateOperationalConfiguration(agent.id, operationalPatch);
      }

      if (hasAdapterRevisionChange) {
        await agentsApi.createAdapterConfigRevision(agent.id, adapterRevisionConfiguration!);
      }
    },
    onMutate: () => {
      setAwaitingRefreshAfterSave(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.detail(agent.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.adapterConfigRevisions(agent.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
      toast.success("Agent saved");
    },
    onError: (err) => {
      setAwaitingRefreshAfterSave(false);
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Could not save agent";
      toast.error("Save failed", { description: message });
    },
  });

  useEffect(() => {
    if (awaitingRefreshAfterSave && agent !== lastAgentRef.current) {
      setAwaitingRefreshAfterSave(false);
    }
    lastAgentRef.current = agent;
  }, [agent, awaitingRefreshAfterSave]);
  const isConfigSaving = updateConfiguration.isPending || awaitingRefreshAfterSave;

  useEffect(() => {
    onDirtyChange(formDirty);
  }, [formDirty, onDirtyChange]);

  useEffect(() => {
    if (formDirty) {
      onSaveActionChange(formSaveAction);
      return;
    }
    onSaveActionChange(null);
  }, [formDirty, formSaveAction, onSaveActionChange]);

  useEffect(() => {
    if (!formDirty) {
      onCancelActionChange(null);
      return;
    }
    onCancelActionChange(() => {
      formCancelAction?.();
    });
  }, [formCancelAction, formDirty, onCancelActionChange]);

  useEffect(() => {
    onSavingChange(isConfigSaving);
  }, [onSavingChange, isConfigSaving]);

  return (
    <div className="space-y-6">
      {updateConfiguration.isPending ? (
        <div
          aria-live="polite"
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner /> Saving agent configuration…
        </div>
      ) : null}
      <FieldSet
        aria-busy={isConfigSaving}
        aria-label="Agent configuration"
        disabled={updateConfiguration.isPending}
      >
        <AgentConfigForm
          mode="edit"
          agent={agent}
          onSave={(patch) => updateConfiguration.mutateAsync(patch)}
          isSaving={isConfigSaving}
          onDirtyChange={setFormDirty}
          onSaveActionChange={handleFormSaveActionChange}
          onCancelActionChange={handleFormCancelActionChange}
          hideInlineSave
        />
      </FieldSet>
      <FieldDescription>
        Saved adapter config affects the next run. Active runs keep the config they started with, and config
        changes may start a fresh adapter session.
      </FieldDescription>
    </div>
  );
}

/* ---- Runs Tab ---- */
