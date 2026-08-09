import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, Users } from "lucide-react";
import type {
  Agent,
  CompanySkillPin,
  CompanySkillDetail,
  CompanySkillUsageAgent,
  CompanySkillVersion,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { companySkillsApi } from "@/api/companySkills";
import { queryKeys } from "@/lib/queryKeys";
import { useOptionalToastActions } from "@/context/ToastContext";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";
import { cn } from "@/lib/utils";

const LATEST_VALUE = "__latest__";

// A single change the operator can request against the skill pins in one
// agent's current immutable adapter revision. Every mutation starts from a
// fresh revision read and appends a new revision.
type SkillChange =
  | { kind: "add" }
  | { kind: "remove" }
  | { kind: "pin"; versionId: string | null };

/**
 * Header pill that shows how many agents have this skill selected
 * and opens the management modal. Owns the dialog's open state so the header
 * stays declarative.
 */
export function AgentsUsingSkillBadge({
  companyId,
  skill,
  canManage = true,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  canManage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = skill.usedByAgents.length;
  const label = `${count} ${count === 1 ? "agent uses" : "agents use"} this skill`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
          count > 0
            ? "border-border bg-muted text-foreground hover:bg-accent"
            : "border-border/60 bg-transparent text-muted-foreground hover:bg-accent/50",
        )}
      >
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        {count} {count === 1 ? "agent" : "agents"}
      </button>
      <AgentsUsingSkillDialog
        open={open}
        onOpenChange={setOpen}
        companyId={companyId}
        skill={skill}
        canManage={canManage}
      />
    </>
  );
}

/**
 * Modal listing the agents that have this skill assigned, with per-agent
 * version pinning and add/remove. Writes append a canonical adapter revision
 * containing the complete exact pin set.
 */
export function AgentsUsingSkillDialog({
  open,
  onOpenChange,
  companyId,
  skill,
  canManage = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  skill: CompanySkillDetail;
  canManage?: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // Lazy: only fetch versions/agents once the modal is open. Skills with no
  // version history (currentVersion === null, e.g. read-only catalog/bundled)
  // never render a pin select, so their versions query stays disabled.
  const hasVersions = skill.currentVersion !== null;
  const versionsQuery = useQuery({
    queryKey: queryKeys.companySkills.versions(companyId, skill.id),
    queryFn: () => companySkillsApi.versions(companyId, skill.id),
    enabled: open && hasVersions,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: open,
  });

  useEffect(() => {
    if (!open) setConfirmRemoveId(null);
  }, [open]);

  const versions = useMemo<CompanySkillVersion[]>(
    () => [...(versionsQuery.data ?? [])].sort((a, b) => b.revisionNumber - a.revisionNumber),
    [versionsQuery.data],
  );
  const latestRevision = skill.currentVersion?.revisionNumber ?? null;
  const revisionByVersionId = useMemo(
    () => new Map(versions.map((version) => [version.id, version.revisionNumber])),
    [versions],
  );

  const agentMetaById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQuery.data],
  );

  // Every non-terminated company agent can receive an explicit company-skill
  // selection. Runtime exposure is owned by the issue-execution boundary.
  const attachedIds = useMemo(
    () => new Set(skill.usedByAgents.map((entry) => entry.id)),
    [skill.usedByAgents],
  );
  const addableAgents = useMemo(
    () =>
      (agentsQuery.data ?? [])
        .filter(
          (agent) =>
            !attachedIds.has(agent.id) &&
            agent.status !== "terminated",
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agentsQuery.data, attachedIds],
  );

  const syncMutation = useMutation({
    mutationFn: async ({
      agent,
      change,
    }: {
      agent: Pick<CompanySkillUsageAgent, "id" | "name"> | Agent;
      change: SkillChange;
    }) => {
      const skillKey = skill.key;
      const selection = await agentsApi.companySkillPins(
        agent.id,
        companyId,
      );
      const currentEntries: CompanySkillPin[] = selection.entries;
      const others = currentEntries.filter((entry) => entry.key !== skillKey);
      const nextEntries = [...others];
      if (change.kind !== "remove") {
        const versionId =
          (change.kind === "pin" ? change.versionId : null)
          ?? skill.currentVersionId;
        if (!versionId) {
          throw new Error("This skill has no immutable version to pin.");
        }
        nextEntries.push({ key: skillKey, versionId });
      }
      // Set-equality round-trip: skip the write if nothing actually changed so
      // we don't churn the agent's config (order-insensitive per b8b6f4446).
      if (selectionSetsEqual(currentEntries, nextEntries)) {
        return { agentId: agent.id, changed: false };
      }
      await agentsApi.replaceCompanySkillPins(
        agent.id,
        nextEntries,
        companyId,
      );
      return { agentId: agent.id, changed: true };
    },
    onSuccess: async ({ agentId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.detail(companyId, skill.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) }),
        // Keep the agent's own Skills tab (PAP-13194) in sync.
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.companySkillPins(agentId),
        }),
      ]);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to update agent skills.";
      toast?.pushToast({
        tone: "error",
        title: "Update failed",
        body: message.includes("403") ? "You don't have permission to change this agent's skills." : message,
      });
    },
  });

  async function applyChange(
    agent: Pick<CompanySkillUsageAgent, "id" | "name"> | Agent,
    change: SkillChange,
  ) {
    setPendingAgentId(agent.id);
    try {
      await syncMutation.mutateAsync({ agent, change });
      setConfirmRemoveId(null);
    } catch {
      // Toast already surfaced by the mutation's onError.
    } finally {
      setPendingAgentId(null);
    }
  }

  const rows = skill.usedByAgents;
  const count = rows.length;
  const assignmentStatus = syncMutation.isPending
    ? "Updating agent skill assignment…"
    : agentsQuery.isLoading
      ? "Loading available agents…"
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Agents using {skill.name}</DialogTitle>
          <DialogDescription>
            {count === 0
              ? "No agents have this skill assigned yet."
              : `${count} ${count === 1 ? "agent has" : "agents have"} this skill selected.`}
          </DialogDescription>
        </DialogHeader>
        {assignmentStatus ? <p role="status" className="sr-only">{assignmentStatus}</p> : null}

        <div className="max-h-80 overflow-y-auto">
          {count === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {canManage
                ? "Add an agent below to assign this skill."
                : "This skill isn't assigned to any agents."}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  icon={agentMetaById.get(agent.id)?.icon ?? null}
                  canManage={canManage}
                  hasVersions={hasVersions}
                  versions={versions}
                  latestRevision={latestRevision}
                  pinnedRevision={agent.versionId ? revisionByVersionId.get(agent.versionId) ?? null : null}
                  busy={pendingAgentId === agent.id}
                  confirmingRemove={confirmRemoveId === agent.id}
                  onRequestRemove={() => setConfirmRemoveId(agent.id)}
                  onCancelRemove={() => setConfirmRemoveId(null)}
                  onRemove={() => applyChange(agent, { kind: "remove" })}
                  onPin={(versionId) => applyChange(agent, { kind: "pin", versionId })}
                />
              ))}
            </ul>
          )}
        </div>

        {canManage ? (
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <AddAgentPicker
              agents={addableAgents}
              loading={agentsQuery.isLoading}
              disabled={syncMutation.isPending}
              onSelect={(agent) => applyChange(agent, { kind: "add" })}
            />
            {syncMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({
  agent,
  icon,
  canManage,
  hasVersions,
  versions,
  latestRevision,
  pinnedRevision,
  busy,
  confirmingRemove,
  onRequestRemove,
  onCancelRemove,
  onRemove,
  onPin,
}: {
  agent: CompanySkillUsageAgent;
  icon: string | null;
  canManage: boolean;
  hasVersions: boolean;
  versions: CompanySkillVersion[];
  latestRevision: number | null;
  pinnedRevision: number | null;
  busy: boolean;
  confirmingRemove: boolean;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  onPin: (versionId: string | null) => void;
}) {
  const behindLatest =
    pinnedRevision !== null && latestRevision !== null && latestRevision > pinnedRevision
      ? latestRevision - pinnedRevision
      : 0;

  return (
    <li className="flex items-center gap-3 py-2.5">
      <AgentIcon icon={icon} className="h-6 w-6 shrink-0 rounded-md text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to={`/agents/${agent.urlKey}/skills`}
          className="truncate text-sm font-medium text-foreground hover:underline"
        >
          {agent.name}
        </Link>
        <span className="truncate text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
          {agent.adapterType}
        </span>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {!hasVersions ? (
          <span className="text-sm text-muted-foreground" aria-label={`${agent.name} version`}>
            —
          </span>
        ) : canManage ? (
          <Select
            value={agent.versionId ?? LATEST_VALUE}
            onValueChange={(v) =>
              onPin(v === LATEST_VALUE ? null : v)
            }
            disabled={busy}
          >
            <SelectTrigger className="h-8 w-auto min-w-(--sz-100px) px-2 text-xs" aria-label={`${agent.name} skill version`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={LATEST_VALUE}>
                Latest{latestRevision !== null ? ` (v${latestRevision})` : ""}
              </SelectItem>
              {versions.map((version) => (
                <SelectItem key={version.id} value={version.id}>
                  v{version.revisionNumber}
                  {version.label ? ` · ${version.label}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">
            {agent.versionId
              ? `v${pinnedRevision ?? "?"}`
              : `Latest${latestRevision !== null ? ` (v${latestRevision})` : ""}`}
          </span>
        )}
        {behindLatest > 0 ? (
          <span className="text-(length:--text-nano) text-amber-500">
            {behindLatest} version{behindLatest === 1 ? "" : "s"} behind latest
          </span>
        ) : null}
      </div>

      {canManage ? (
        confirmingRemove ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="destructive"
              size="sm"
              onClick={onRemove}
              disabled={busy}
              aria-label={`Confirm removing this skill from ${agent.name}`}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Remove"}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelRemove} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRequestRemove}
            disabled={busy}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Remove this skill from ${agent.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )
      ) : null}
    </li>
  );
}

function AddAgentPicker({
  agents,
  loading,
  disabled,
  onSelect,
}: {
  agents: Agent[];
  loading: boolean;
  disabled: boolean;
  onSelect: (agent: Agent) => void;
}) {
  type AgentOption = SearchableSelectOption<string> & { agent: Agent };
  const groups = useMemo<readonly SearchableSelectGroup<string, AgentOption>[]>(() => {
    const options: AgentOption[] = agents.map((agent) => ({
      key: agent.id,
      value: agent.id,
      label: agent.name,
      title: agent.name,
      searchText: [agent.name, agent.adapterType].join(" "),
      agent,
    }));
    return [{ id: "agents", options }];
  }, [agents]);

  return (
    <SearchableSelect<string, AgentOption>
      value=""
      groups={groups}
      loading={loading}
      loadingMessage="Loading agents..."
      placeholder="Add agent…"
      searchPlaceholder="Search agents..."
      emptyMessage="All eligible agents already have this skill."
      disabled={disabled}
      onValueChange={(_value, option) => {
        onSelect(option.agent);
        return { close: true };
      }}
      triggerClassName="h-8 w-full justify-start"
      contentClassName="w-72"
      renderValue={() => (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add agent…
        </span>
      )}
      renderOption={(option) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{option.label}</span>
          <span className="truncate text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
            {option.agent.adapterType}
          </span>
        </span>
      )}
    />
  );
}

/** Order-insensitive comparison of selections by (key, versionId). */
function selectionSetsEqual(
  a: CompanySkillPin[],
  b: CompanySkillPin[],
): boolean {
  if (a.length !== b.length) return false;
  const encode = (entry: CompanySkillPin) =>
    `${entry.key}\u0000${entry.versionId}`;
  const setA = new Set(a.map(encode));
  return b.every((entry) => setA.has(encode(entry)));
}
