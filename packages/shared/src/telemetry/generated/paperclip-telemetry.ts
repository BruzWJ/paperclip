// GENERATED — DO NOT EDIT.

import type { AgentAdapterType } from "../../constants.js";

export interface PaperclipAgentCreatedDimensions {
agent_id: string
}

export interface PaperclipAgentIssueCompletedDimensions {
adapter_type: AgentAdapterType
agent_id: string
model?: string
}

export interface PaperclipCompanyImportedDimensions {
source_type: ("local_path" | "github" | "url" | "catalog" | "skills_sh" | "unknown")
source_ref?: string
source_ref_hashed?: boolean
}

export interface PaperclipErrorHandlerCrashDimensions {
error_code: string
}

export interface PaperclipGoalCreatedDimensions {
goal_level: ("company" | "team" | "agent" | "issue" | "other")
}

export interface PaperclipInstallCompletedDimensions {
adapter_type: AgentAdapterType
}

export interface PaperclipInstallStartedDimensions {

}

export interface PaperclipProjectCreatedDimensions {

}

export interface PaperclipRoutineCreatedDimensions {

}

export interface PaperclipRoutineRunDimensions {
source: ("schedule" | "manual" | "api" | "webhook" | "other")
status: ("received" | "coalesced" | "skipped" | "issue_created" | "completed" | "failed" | "other")
}

export interface PaperclipSkillImportedDimensions {
source_type: ("local_path" | "github" | "url" | "catalog" | "skills_sh" | "unknown")
skill_ref?: string
}

export type PaperclipEventName =
  | "agent.created"
  | "agent.issue_completed"
  | "company.imported"
  | "error.handler_crash"
  | "goal.created"
  | "install.completed"
  | "install.started"
  | "project.created"
  | "routine.created"
  | "routine.run"
  | "skill.imported";

export interface EventDimensionsMap {
  "agent.created": PaperclipAgentCreatedDimensions;
  "agent.issue_completed": PaperclipAgentIssueCompletedDimensions;
  "company.imported": PaperclipCompanyImportedDimensions;
  "error.handler_crash": PaperclipErrorHandlerCrashDimensions;
  "goal.created": PaperclipGoalCreatedDimensions;
  "install.completed": PaperclipInstallCompletedDimensions;
  "install.started": PaperclipInstallStartedDimensions;
  "project.created": PaperclipProjectCreatedDimensions;
  "routine.created": PaperclipRoutineCreatedDimensions;
  "routine.run": PaperclipRoutineRunDimensions;
  "skill.imported": PaperclipSkillImportedDimensions;
}

export const PAPERCLIP_EVENTS = {
  "agent.created": "agent.created",
  "agent.issue_completed": "agent.issue_completed",
  "company.imported": "company.imported",
  "error.handler_crash": "error.handler_crash",
  "goal.created": "goal.created",
  "install.completed": "install.completed",
  "install.started": "install.started",
  "project.created": "project.created",
  "routine.created": "routine.created",
  "routine.run": "routine.run",
  "skill.imported": "skill.imported",
} as const;

export const PAPERCLIP_ENUM_DESCRIPTIONS = {
  "company.imported": {
    "source_type": {
      "local_path": "Import source came from a filesystem path on the operator's machine.",
      "github": "Import source came from a GitHub repository or GitHub-backed reference.",
      "url": "Import source came from a direct URL.",
      "catalog": "Import source came from a Paperclip catalog entry.",
      "skills_sh": "Import source came from a Skills.sh-compatible source.",
      "unknown": "Source type could not be classified."
    }
  },
  "goal.created": {
    "goal_level": {
      "company": "Goal applies at company scope.",
      "team": "Goal applies at team or group scope.",
      "agent": "Goal applies to a specific agent.",
      "issue": "Goal applies to issue-level work.",
      "other": "Fallback when the goal level is unknown or not represented by the tracked enum."
    }
  },
  "routine.run": {
    "source": {
      "schedule": "Routine was triggered by a scheduled trigger.",
      "manual": "Routine was triggered manually by a user or agent action.",
      "api": "Routine was triggered through an API request.",
      "webhook": "Routine was triggered by a webhook.",
      "other": "Fallback when the source is unknown or not represented by the tracked enum."
    },
    "status": {
      "received": "Routine run was accepted for processing.",
      "coalesced": "A live execution already existed and the run was coalesced into it.",
      "skipped": "A live execution already existed and concurrency policy skipped the run.",
      "issue_created": "Routine dispatch created a new issue-execution reference for runner dispatch.",
      "completed": "Routine run completed without needing a new issue.",
      "failed": "Routine dispatch failed and the run was finalized as failed.",
      "other": "Fallback when the status is unknown or not represented by the tracked enum."
    }
  },
  "skill.imported": {
    "source_type": {
      "local_path": "Import source came from a filesystem path on the operator's machine.",
      "github": "Import source came from a GitHub repository or GitHub-backed reference.",
      "url": "Import source came from a direct URL.",
      "catalog": "Import source came from a Paperclip catalog entry.",
      "skills_sh": "Import source came from a Skills.sh-compatible source.",
      "unknown": "Source type could not be classified."
    }
  }
} as const;

export const SCHEMA_VERSION = "1" as const;

export interface PaperclipTelemetryEvent<K extends PaperclipEventName = PaperclipEventName> {
name: K
occurredAt: string
dimensions: EventDimensionsMap[K]
}

export type AnyPaperclipTelemetryEvent = {
  [K in PaperclipEventName]: PaperclipTelemetryEvent<K>
}[PaperclipEventName];

export interface PaperclipTelemetryBatch {
app: "paperclip"
schemaVersion: typeof SCHEMA_VERSION
installId: string
version?: string
events: AnyPaperclipTelemetryEvent[]
}

export function makeEvent<K extends PaperclipEventName>(
  name: K,
  dimensions: EventDimensionsMap[K],
  occurredAt: string
): PaperclipTelemetryEvent<K> {
  return { name, occurredAt, dimensions };
}

export function makeBatch(
  installId: string,
  events: readonly AnyPaperclipTelemetryEvent[],
  version?: string
): PaperclipTelemetryBatch {
  return {
    app: "paperclip",
    schemaVersion: SCHEMA_VERSION,
    installId,
    ...(version === undefined ? {} : { version }),
    events: [...events]
  };
}
