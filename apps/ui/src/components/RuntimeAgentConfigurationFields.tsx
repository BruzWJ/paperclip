import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ContextAccessMatrix } from "./ContextAccessMatrix";

export type RuntimeAgentConfigurationValues = {
  contextGrants: Record<AgentContextGrantKey, boolean>;
  actionGrants: Record<PaperclipActionKey, boolean>;
  mentionReachGrants: Record<AgentMentionReachGrantKey, boolean>;
};

type ContextAccessPreset =
  | "heads_down"
  | "focused"
  | "supervisor"
  | "investigator"
  | "situational";

const ACTION_LABELS: Record<
  PaperclipActionKey,
  { label: string; description: string }
> = {
  issue_create: {
    label: "Create and assign issues",
    description:
      "Create direct child issues and reassign eligible direct children created by this execution.",
  },
  mention_board: {
    label: "Can mention Board",
    description: "Post a canonical issue comment to the collective Board.",
  },
  agent_hire: {
    label: "Hire direct-child agents",
    description: "Create an ordinary direct-child agent.",
  },
  agent_configure: {
    label: "Configure agents",
    description: "Edit an explicitly authorized target's identity, dials, and grants.",
  },
  list_all_agents: {
    label: "List all agents",
    description: "List all non-terminated agents in the company with their identity, capabilities, and reporting hierarchy.",
  },
  list_parent_agents: {
    label: "List team agents",
    description: "List agents under the current agent's parent, scoped to the reporting team. Can also target a specific agent within the team subtree.",
  },
};

const MENTION_LABELS: Record<
  AgentMentionReachGrantKey,
  { label: string; description: string }
> = {
  mention_any_descendant: {
    label: "Mention any descendant",
    description: "Add eligible descendants that own work in the current issue tree.",
  },
  mention_any_ancestor: {
    label: "Mention any ancestor",
    description: "Add ancestors up to the current root issue owner.",
  },
};

const PRESET_LABELS: Record<ContextAccessPreset, string> = {
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

const CONTEXT_ACCESS_PRESETS: Record<
  ContextAccessPreset,
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
  };
}

function matchingContextAccessPreset(
  contextGrants: Record<AgentContextGrantKey, boolean>,
): ContextAccessPreset | "custom" {
  for (const preset of Object.keys(CONTEXT_ACCESS_PRESETS) as ContextAccessPreset[]) {
    if (
      AGENT_CONTEXT_GRANT_KEYS.every(
        (key) => CONTEXT_ACCESS_PRESETS[preset][key] === contextGrants[key],
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
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

export function RuntimeAgentConfigurationFields({
  value,
  onChange,
  disabled = false,
}: {
  value: RuntimeAgentConfigurationValues;
  onChange: (value: RuntimeAgentConfigurationValues) => void;
  disabled?: boolean;
}) {
  const activePreset = matchingContextAccessPreset(value.contextGrants);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Runtime access</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Context access controls what this agent can see; actions control what it
          can do. The two dials are independent.
        </p>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Context access
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Presets stamp concrete cells once; later edits do not stay linked.
            </p>
          </div>
          <Select
            value={activePreset}
            onValueChange={(v) => {
              if (v === "custom") return;
              const preset = v as ContextAccessPreset;
              onChange({
                ...value,
                contextGrants: { ...CONTEXT_ACCESS_PRESETS[preset] },
              });
            }}
            disabled={disabled}
          >
            <SelectTrigger className="h-auto px-2 py-1.5 text-xs" aria-label="Context access preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {activePreset === "custom" ? (
                <SelectItem value="custom">Custom</SelectItem>
              ) : null}
              {(Object.keys(PRESET_LABELS) as ContextAccessPreset[]).map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {PRESET_LABELS[preset]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ContextAccessMatrix
          value={value.contextGrants}
          disabled={disabled}
          enabledLabel="allowed"
          disabledLabel="blocked"
          description="Checked cells grant this agent that level of context access. Unchecked cells remain unavailable."
          testId="agent-context-access-matrix"
          onCellChange={(key, enabled) =>
            onChange({
              ...value,
              contextGrants: {
                ...value.contextGrants,
                [key]: enabled,
              },
            })
          }
        />
      </div>

      <div className="rounded-lg border border-border p-4">
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Paperclip actions
        </h4>
        <p className="mb-3 text-xs text-muted-foreground">
          Issue updates are relationship-derived: the owner updates its active
          issue, and the creator can message or set open/blocked on eligible
          direct children through the same canonical action. Terminal updates
          remain owner-only. Each update canonically mentions its counterpart
          automatically, so no lifecycle or separate comment control is
          configured here.
        </p>
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

    </div>
  );
}
