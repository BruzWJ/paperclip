import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
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
  mention_agent: {
    label: "Mention agents",
    description: "Post a canonical same-issue comment to an eligible agent.",
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
  list_agents: {
    label: "List agents",
    description: "List all non-terminated agents in the company with their identity, capabilities, and reporting hierarchy.",
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
      <ToggleSwitch
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
          <select
            aria-label="Context access preset"
            className="rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={activePreset}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.value === "custom") return;
              const preset = event.target.value as ContextAccessPreset;
              onChange({
                ...value,
                contextGrants: { ...CONTEXT_ACCESS_PRESETS[preset] },
              });
            }}
          >
            {activePreset === "custom" ? (
              <option value="custom">Custom</option>
            ) : null}
            {(Object.keys(PRESET_LABELS) as ContextAccessPreset[]).map((preset) => (
              <option key={preset} value={preset}>
                {PRESET_LABELS[preset]}
              </option>
            ))}
          </select>
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
