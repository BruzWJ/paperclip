import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";

export type RuntimeAgentConfigurationValues = {
  contextGrants: Record<AgentContextGrantKey, boolean>;
  actionGrants: Record<PaperclipActionKey, boolean>;
  mentionReachGrants: Record<AgentMentionReachGrantKey, boolean>;
  companyToolIds: string[];
};

type AttentionPreset =
  | "heads_down"
  | "focused"
  | "supervisor"
  | "investigator"
  | "situational";

const CONTEXT_LABELS: Record<
  AgentContextGrantKey,
  { label: string; description: string }
> = {
  carry_context: {
    label: "Carry current-issue session",
    description:
      "Resume this issue's provider session across requests in the same ownership epoch.",
  },
  read_issue_comments: {
    label: "Current issue · comments",
    description: "Read and compose this issue's chronological thread.",
  },
  read_issue_agent_run: {
    label: "Current issue · agent runs",
    description: "Inspect structured run turns referenced by this issue.",
  },
  list_sub_issues: {
    label: "Sub-issues · list and content",
    description: "Descend through issues beneath the active issue.",
  },
  read_sub_issue_comments: {
    label: "Sub-issues · comments",
    description: "Read comments for descendants in reach.",
  },
  read_sub_issue_agent_run: {
    label: "Sub-issues · agent runs",
    description: "Inspect structured run turns for descendants in reach.",
  },
  list_company_issues: {
    label: "Company · list and content",
    description: "List top-level company issues and descend their trees.",
  },
  read_company_issue_comments: {
    label: "Company · comments",
    description: "Read comments for same-company issues.",
  },
  read_company_issue_agent_run: {
    label: "Company · agent runs",
    description: "Inspect structured run turns for same-company issues.",
  },
};

const ACTION_LABELS: Record<
  PaperclipActionKey,
  { label: string; description: string }
> = {
  issue_create: {
    label: "Create issues",
    description: "Create owned issues or direct child issues.",
  },
  issue_assign: {
    label: "Assign issues",
    description: "Reassign an open issue when immutable creator authority permits.",
  },
  issue_update: {
    label: "Update issue lifecycle",
    description: "Send the creator↔owner lifecycle message.",
  },
  mention_agent: {
    label: "Mention agents",
    description: "Consult an eligible agent on the same issue.",
  },
  agent_hire: {
    label: "Hire direct-child agents",
    description: "Create an ordinary direct-child agent.",
  },
  agent_configure: {
    label: "Configure agents",
    description: "Edit an explicitly authorized target's identity, dials, and grants.",
  },
};

const MENTION_LABELS: Record<
  AgentMentionReachGrantKey,
  { label: string; description: string }
> = {
  mention_any_descendant: {
    label: "Mention any descendant",
    description: "Extend consult candidates down the reporting chain.",
  },
  mention_any_ancestor: {
    label: "Mention any ancestor",
    description: "Extend consult candidates up the reporting chain.",
  },
};

const PRESET_LABELS: Record<AttentionPreset, string> = {
  heads_down: "Heads-down",
  focused: "Focused",
  supervisor: "Supervisor",
  investigator: "Investigator",
  situational: "Situational",
};

function booleanMap<Key extends string>(
  keys: readonly Key[],
  enabled: readonly Key[] = [],
): Record<Key, boolean> {
  const enabledSet = new Set(enabled);
  return Object.fromEntries(
    keys.map((key) => [key, enabledSet.has(key)]),
  ) as Record<Key, boolean>;
}

const ATTENTION_PRESETS: Record<
  AttentionPreset,
  Record<AgentContextGrantKey, boolean>
> = {
  heads_down: booleanMap(AGENT_CONTEXT_GRANT_KEYS),
  focused: booleanMap(AGENT_CONTEXT_GRANT_KEYS, [
    "carry_context",
    "read_issue_comments",
  ]),
  supervisor: booleanMap(AGENT_CONTEXT_GRANT_KEYS, [
    "carry_context",
    "read_issue_comments",
    "list_sub_issues",
    "read_sub_issue_comments",
  ]),
  investigator: booleanMap(AGENT_CONTEXT_GRANT_KEYS, [
    "carry_context",
    "read_issue_comments",
    "list_sub_issues",
    "read_sub_issue_comments",
    "read_issue_agent_run",
  ]),
  situational: booleanMap(AGENT_CONTEXT_GRANT_KEYS, [
    "carry_context",
    "read_issue_comments",
    "list_sub_issues",
    "read_sub_issue_comments",
    "read_issue_agent_run",
    "list_company_issues",
  ]),
};

export function createEmptyRuntimeAgentConfigurationValues(): RuntimeAgentConfigurationValues {
  return {
    contextGrants: booleanMap(AGENT_CONTEXT_GRANT_KEYS),
    actionGrants: booleanMap(PAPERCLIP_ACTION_KEYS),
    mentionReachGrants: booleanMap(AGENT_MENTION_REACH_GRANT_KEYS),
    companyToolIds: [],
  };
}

function matchingAttentionPreset(
  contextGrants: Record<AgentContextGrantKey, boolean>,
): AttentionPreset | "custom" {
  for (const preset of Object.keys(ATTENTION_PRESETS) as AttentionPreset[]) {
    if (
      AGENT_CONTEXT_GRANT_KEYS.every(
        (key) => ATTENTION_PRESETS[preset][key] === contextGrants[key],
      )
    ) {
      return preset;
    }
  }
  return "custom";
}

function ConfigurationRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <ToggleSwitch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function RuntimeAgentConfigurationFields({
  companyId,
  agentId,
  value,
  onChange,
  disabled = false,
}: {
  companyId: string;
  agentId?: string | null;
  value: RuntimeAgentConfigurationValues;
  onChange: (value: RuntimeAgentConfigurationValues) => void;
  disabled?: boolean;
}) {
  const toolOptions = useQuery({
    queryKey: agentId
      ? queryKeys.agents.runtimeToolOptions(agentId)
      : queryKeys.agents.createRuntimeToolOptions(companyId),
    queryFn: () =>
      agentId
        ? agentsApi.listRuntimeAgentToolOptions(agentId, companyId)
        : agentsApi.listCreateRuntimeAgentToolOptions(companyId),
    enabled: Boolean(companyId),
  });
  const availableTools = useMemo(() => {
    return (toolOptions.data ?? [])
      .map((option) => ({
        id: option.catalogEntryId,
        label: option.title,
        description: option.description,
        connectionName: option.connectionName,
      }))
      .sort(
        (left, right) =>
          left.connectionName.localeCompare(right.connectionName) ||
          left.label.localeCompare(right.label),
      );
  }, [toolOptions.data]);
  const availableToolIds = useMemo(
    () => new Set(availableTools.map((tool) => tool.id)),
    [availableTools],
  );
  const unavailableSelectedToolIds = value.companyToolIds.filter(
    (id) => !availableToolIds.has(id),
  );
  const toolsLoading = toolOptions.isLoading;
  const toolsError = toolOptions.error;
  const activePreset = matchingAttentionPreset(value.contextGrants);

  function toggleCompanyTool(id: string, checked: boolean) {
    const next = checked
      ? [...new Set([...value.companyToolIds, id])]
      : value.companyToolIds.filter((candidate) => candidate !== id);
    onChange({ ...value, companyToolIds: next.sort() });
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Runtime access</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Context controls what this agent can see; actions control what it can
          do. Every cell is explicit and independently editable.
        </p>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Context dial
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Presets stamp concrete cells once; later edits do not stay linked.
            </p>
          </div>
          <select
            aria-label="Attention preset"
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none"
            value={activePreset}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value === "custom") return;
              const preset = event.target.value as AttentionPreset;
              onChange({
                ...value,
                contextGrants: { ...ATTENTION_PRESETS[preset] },
              });
            }}
          >
            {activePreset === "custom" ? (
              <option value="custom">Custom</option>
            ) : null}
            {(Object.keys(PRESET_LABELS) as AttentionPreset[]).map((preset) => (
              <option key={preset} value={preset}>
                {PRESET_LABELS[preset]}
              </option>
            ))}
          </select>
        </div>
        {AGENT_CONTEXT_GRANT_KEYS.map((key) => (
          <ConfigurationRow
            key={key}
            {...CONTEXT_LABELS[key]}
            checked={value.contextGrants[key]}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({
                ...value,
                contextGrants: {
                  ...value.contextGrants,
                  [key]: checked,
                },
              })
            }
          />
        ))}
      </div>

      <div className="rounded-lg border border-border p-4">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Paperclip actions
        </h4>
        {PAPERCLIP_ACTION_KEYS.map((key) => (
          <ConfigurationRow
            key={key}
            {...ACTION_LABELS[key]}
            checked={value.actionGrants[key]}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({
                ...value,
                actionGrants: {
                  ...value.actionGrants,
                  [key]: checked,
                },
              })
            }
          />
        ))}
      </div>

      <div className="rounded-lg border border-border p-4">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Mention reach
        </h4>
        {AGENT_MENTION_REACH_GRANT_KEYS.map((key) => (
          <ConfigurationRow
            key={key}
            {...MENTION_LABELS[key]}
            checked={value.mentionReachGrants[key]}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({
                ...value,
                mentionReachGrants: {
                  ...value.mentionReachGrants,
                  [key]: checked,
                },
              })
            }
          />
        ))}
      </div>

      <div className="rounded-lg border border-border p-4">
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Company tools
        </h4>
        <p className="mb-3 text-xs text-muted-foreground">
          {agentId
            ? "Only concrete tools installed for this exact agent can be selected. Tool policy can still narrow calls at runtime."
            : "Select from company-installed tools. Their exact connections are bound to the new agent atomically when it is created."}
        </p>
        {toolsLoading ? (
          <p className="text-xs text-muted-foreground">Loading company tools…</p>
        ) : toolsError ? (
          <p role="alert" className="text-xs text-destructive">
            {toolsError instanceof Error
              ? toolsError.message
              : "Company tools could not be loaded."}
          </p>
        ) : availableTools.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {agentId
              ? "No active tools are installed for this exact agent."
              : "No active company-installed tools are available for agent creation."}
          </p>
        ) : (
          <div className="space-y-3">
            {availableTools.map((tool) => {
              const inputId = `runtime-tool-${agentId ?? "new"}-${tool.id}`;
              return (
                <div key={tool.id} className="flex items-start gap-3">
                  <Checkbox
                    id={inputId}
                    checked={value.companyToolIds.includes(tool.id)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      toggleCompanyTool(tool.id, checked === true)
                    }
                  />
                  <label htmlFor={inputId} className="grid gap-0.5 leading-none">
                    <span className="text-sm font-medium">{tool.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {tool.connectionName}
                      {tool.description ? ` · ${tool.description}` : ""}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        )}
        {unavailableSelectedToolIds.length > 0 ? (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {unavailableSelectedToolIds.length} selected tool
            {unavailableSelectedToolIds.length === 1 ? "" : "s"} no longer
            resolve to an active install. Deselect them before saving.
          </p>
        ) : null}
      </div>
    </div>
  );
}
