import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
  type AgentContextGrantKey,
  type AgentMentionReachGrantKey,
  type PaperclipActionKey,
} from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsSwitchField } from "@/components/patterns/FormPatterns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ContextAccessMatrix } from "./ContextAccessMatrix";

export type RuntimeAgentConfigurationValues = {
  contextGrants: Record<AgentContextGrantKey, boolean>;
  actionGrants: Record<PaperclipActionKey, boolean>;
  mentionReachGrants: Record<AgentMentionReachGrantKey, boolean>;
};

type ContextAccessPreset = "heads_down" | "focused" | "supervisor" | "investigator" | "situational";

interface ConfigurationOptionCopy {
  label: string;
  description: string;
}

const ACTION_LABELS: Record<PaperclipActionKey, ConfigurationOptionCopy> = {
  task_create: {
    label: "Create and assign tasks",
    description: "Create direct child tasks and reassign eligible direct children created by this execution.",
  },
  mention_board: {
    label: "Can mention Board",
    description: "Post a canonical task comment to the collective Board.",
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
    description:
      "List all non-terminated agents in the company with their identity, capabilities, and reporting hierarchy.",
  },
  list_parent_agents: {
    label: "List team agents",
    description:
      "List agents under the current agent's parent, scoped to the reporting team. Can also target a specific agent within the team subtree.",
  },
};

const MENTION_LABELS: Record<AgentMentionReachGrantKey, ConfigurationOptionCopy> = {
  mention_any_descendant: {
    label: "Mention any descendant",
    description: "Add eligible descendants that own work in the current task tree.",
  },
  mention_any_ancestor: {
    label: "Mention any ancestor",
    description: "Add ancestors up to the current root task owner.",
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
  return Object.fromEntries(keys.map((key) => [key, enabledSet.has(key)])) as Record<Key, boolean>;
}

const CONTEXT_ACCESS_PRESETS: Record<ContextAccessPreset, Record<AgentContextGrantKey, boolean>> = {
  heads_down: booleanMap(AGENT_CONTEXT_GRANT_KEYS),
  focused: booleanMap(AGENT_CONTEXT_GRANT_KEYS, ["carry_context", "read_task_comments"]),
  supervisor: booleanMap(AGENT_CONTEXT_GRANT_KEYS, [
    "carry_context",
    "read_task_comments",
    "list_sub_tasks",
    "read_sub_task_comments",
  ]),
  investigator: booleanMap(AGENT_CONTEXT_GRANT_KEYS, [
    "carry_context",
    "read_task_comments",
    "list_sub_tasks",
    "read_sub_task_comments",
    "read_task_agent_run",
  ]),
  situational: booleanMap(AGENT_CONTEXT_GRANT_KEYS, [
    "carry_context",
    "read_task_comments",
    "list_sub_tasks",
    "read_sub_task_comments",
    "read_task_agent_run",
    "list_company_tasks",
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
    if (AGENT_CONTEXT_GRANT_KEYS.every((key) => CONTEXT_ACCESS_PRESETS[preset][key] === contextGrants[key])) {
      return preset;
    }
  }
  return "custom";
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
          Context access controls what this agent can see; actions control what it can do. The two dials are
          independent.
        </p>
      </div>

      <Card className="gap-3 py-4">
        <CardHeader className="flex-row items-center justify-between px-4">
          <div>
            <CardTitle className="text-sm">Context access</CardTitle>
            <CardDescription className="text-xs">
              Presets stamp concrete cells once; later edits do not stay linked.
            </CardDescription>
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
              {activePreset === "custom" ? <SelectItem value="custom">Custom</SelectItem> : null}
              {(Object.keys(PRESET_LABELS) as ContextAccessPreset[]).map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {PRESET_LABELS[preset]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="px-4">
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
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="gap-1 px-4">
          <CardTitle className="text-sm">Paperclip actions</CardTitle>
          <CardDescription className="text-xs">
            Task updates are relationship-derived: the owner updates its active task, and the creator can
            message or set open/blocked on eligible direct children through the same canonical action.
            Terminal updates remain owner-only. Each update canonically mentions its counterpart
            automatically, so no lifecycle or separate comment control is configured here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-4">
          {PAPERCLIP_ACTION_KEYS.map((key) => {
            const presentation = ACTION_LABELS[key];
            return (
              <SettingsSwitchField
                key={key}
                id={`runtime-action-${key}`}
                label={presentation.label}
                description={presentation.description}
                checked={value.actionGrants[key]}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    actionGrants: { ...value.actionGrants, [key]: checked },
                  })
                }
              />
            );
          })}
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">Mention reach</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 px-4">
          {AGENT_MENTION_REACH_GRANT_KEYS.map((key) => {
            const presentation = MENTION_LABELS[key];
            return (
              <SettingsSwitchField
                key={key}
                id={`runtime-mention-${key}`}
                label={presentation.label}
                description={presentation.description}
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
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
