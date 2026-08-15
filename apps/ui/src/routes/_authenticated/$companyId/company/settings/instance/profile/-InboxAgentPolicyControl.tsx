// Empty collections render dedicated UI when data.length === 0.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Save } from "lucide-react";
import type { InboxAgentPolicy, InboxAgentPolicyMode } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { inboxAgentPolicyApi } from "@/api/inbox-agent-policy";
import { queryKeys } from "@/lib/queryKeys";
import { isAgentTaskTarget } from "@/lib/company-members";
import { AgentIcon } from "../../../../-AgentIconPicker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { FieldLabel, FieldSet } from "@/components/ui/field";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Choicebox,
  ChoiceboxIndicator,
  ChoiceboxItem,
  ChoiceboxItemDescription,
  ChoiceboxItemHeader,
  ChoiceboxItemTitle,
} from "@/components/kibo-ui/choicebox";

const MODE_OPTIONS: { value: string; title: string; description?: string }[] = [
  {
    value: "open",
    title: "Any of my agents",
    description: "Let any agent you manage archive tasks out of your inbox.",
  },
  {
    value: "allowlist",
    title: "Only chosen agents",
    description: "Restrict inbox tidying to the agents you pick below.",
  },
  {
    value: "disabled",
    title: "Off",
    description: "Agents can never archive tasks from your inbox.",
  },
];

function policyKey(mode: InboxAgentPolicyMode, allowedAgentIds: string[]): string {
  return `${mode}:${[...allowedAgentIds].sort().join(",")}`;
}

interface Draft {
  mode: InboxAgentPolicyMode;
  allowedAgentIds: string[];
}

/**
 * "Let agents tidy my inbox" user-settings control. A single
 * three-state policy — `open` / `allowlist` / `disabled` — round-tripped through
 * the per-user endpoints. When `allowlist` is selected the user picks which
 * of their agents may archive. The one-click Undo/Unarchive affordance and the
 * "Archived by …" attribution live elsewhere (inbox rows / properties pane).
 */
export function InboxAgentPolicyControl({
  companyId,
  userId,
}: {
  companyId: string | null | undefined;
  userId: string;
}) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const lastServerKeyRef = useRef<string | null>(null);

  const policyQuery = useQuery({
    queryKey: companyId ? queryKeys.inboxAgentPolicy(companyId, userId) : ["inbox-agent-policy", "none"],
    queryFn: () => inboxAgentPolicyApi.get(companyId!, userId),
    enabled: !!companyId,
  });
  const policy = policyQuery.data;

  const agentsQuery = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const selectableAgents = useMemo(
    () => (agentsQuery.data ?? []).filter(isAgentTaskTarget),
    [agentsQuery.data],
  );

  // Adopt server state on first load, or on refetch when the user has not
  // diverged from the previously-synced snapshot (so a background refetch never
  // clobbers pending edits).
  useEffect(() => {
    if (!policy) return;
    const serverKey = policyKey(policy.mode, policy.allowedAgentIds);
    setDraft((current) => {
      if (current === null || policyKey(current.mode, current.allowedAgentIds) === lastServerKeyRef.current) {
        return { mode: policy.mode, allowedAgentIds: policy.allowedAgentIds };
      }
      return current;
    });
    lastServerKeyRef.current = serverKey;
  }, [policy]);

  const updateMutation = useMutation({
    mutationFn: (next: Draft) =>
      inboxAgentPolicyApi.update(companyId!, userId, {
        mode: next.mode,
        allowedAgentIds: next.mode === "allowlist" ? next.allowedAgentIds : [],
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData<InboxAgentPolicy>(queryKeys.inboxAgentPolicy(companyId!, userId), saved);
    },
  });

  const isDirty = Boolean(
    draft &&
    policy &&
    policyKey(draft.mode, draft.allowedAgentIds) !== policyKey(policy.mode, policy.allowedAgentIds),
  );

  if (policyQuery.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {policyQuery.error instanceof Error
            ? policyQuery.error.message
            : "Failed to load inbox agent policy."}
        </AlertDescription>
      </Alert>
    );
  }

  if (policyQuery.isLoading || !draft) {
    return <Skeleton className="h-40 max-w-2xl" aria-label="Loading inbox agent policy" />;
  }

  const toggleAgent = (agentId: string, checked: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const set = new Set(current.allowedAgentIds);
      if (checked) set.add(agentId);
      else set.delete(agentId);
      return { ...current, allowedAgentIds: [...set] };
    });
  };

  return (
    <section className="space-y-4" aria-label="Let agents tidy my inbox">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-muted-foreground"  data-icon="inline-start"/>
          <h2 className="text-base font-semibold">Let agents tidy my inbox</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Choose whether the agents you manage may archive tasks out of your inbox on your behalf. You can
          undo any archive, and every agent archive is attributed in the task&apos;s properties.
        </p>
      </div>

      <FieldSet className="max-w-2xl">
        <Choicebox
          aria-label="Inbox agent archiving policy"
          value={draft.mode}
          onValueChange={(value) =>
            setDraft((current) => (current ? { ...current, mode: value as InboxAgentPolicyMode } : current))
          }
        >
          {MODE_OPTIONS.map((option) => (
            <ChoiceboxItem key={option.value} id={option.value} value={option.value}>
              <ChoiceboxItemHeader>
                <ChoiceboxItemTitle>{option.title}</ChoiceboxItemTitle>
                {option.description ? (
                  <ChoiceboxItemDescription>{option.description}</ChoiceboxItemDescription>
                ) : null}
              </ChoiceboxItemHeader>
              <ChoiceboxIndicator id={option.value} />
            </ChoiceboxItem>
          ))}
        </Choicebox>
      </FieldSet>

      {draft.mode === "allowlist" ? (
        <FieldSet className="max-w-2xl rounded-md border p-3">
          <div className="text-sm font-medium">Agents allowed to tidy my inbox</div>
          {selectableAgents.length === 0 ? (
            <p className="text-xs text-muted-foreground">You don&apos;t manage any agents yet.</p>
          ) : (
            <ItemGroup>
              {selectableAgents.map((agent) => {
                const checked = draft.allowedAgentIds.includes(agent.id);
                return (
                  <Item key={agent.id} size="sm">
                    <FieldLabel htmlFor={`inbox-agent-${agent.id}`} className="w-full">
                      <Checkbox
                        id={`inbox-agent-${agent.id}`}
                        checked={checked}
                        onCheckedChange={(next) => toggleAgent(agent.id, next === true)}
                        aria-label={`Allow ${agent.name} to tidy my inbox`}
                      />
                      <ItemMedia>
                        <AgentIcon icon={agent.icon} />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{agent.name}</ItemTitle>
                      </ItemContent>
                      {agent.title ? (
                        <span className="shrink-0 text-xs text-muted-foreground">{agent.title}</span>
                      ) : null}
                    </FieldLabel>
                  </Item>
                );
              })}
            </ItemGroup>
          )}
        </FieldSet>
      ) : null}

      {updateMutation.error ? (
        <Alert variant="destructive" className="max-w-2xl">
          <AlertDescription>
            {updateMutation.error instanceof Error
              ? updateMutation.error.message
              : "Failed to save inbox agent policy."}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex max-w-2xl items-center justify-end gap-3">
        {updateMutation.isSuccess && !isDirty ? (
          <span className="text-xs text-muted-foreground" role="status">
            Saved
          </span>
        ) : null}
        <Button
          type="button"
          disabled={!isDirty || updateMutation.isPending}
          onClick={() => draft && updateMutation.mutate(draft)}
        >
          {updateMutation.isPending ? <Spinner /> : <Save className="size-4"  data-icon="inline-start"/>}
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}
