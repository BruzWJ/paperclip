// GENERATED — DO NOT EDIT.

export interface PaperclipAgentCreatedDimensions {
agent_id: string
}

export interface PaperclipAgentTaskCompletedDimensions {
adapter_type: string
agent_id: string
model?: string
}

export interface PaperclipCompanyImportedDimensions {
source_type: ("local_path" | "github")
source_ref?: string
source_ref_hashed?: boolean
}

export interface PaperclipErrorHandlerCrashDimensions {
error_code: string
}

export interface PaperclipGoalCreatedDimensions {
goal_level: ("company" | "team" | "agent" | "task")
}

export interface PaperclipInstallStartedDimensions {

}

export interface PaperclipProjectCreatedDimensions {

}

export interface PaperclipRoutineCreatedDimensions {

}

export interface PaperclipRoutineRunDimensions {
source: ("schedule" | "manual" | "api" | "webhook")
status: ("received" | "coalesced" | "skipped" | "task_created" | "completed" | "failed")
}

export type PaperclipEventName =
  | "agent.created"
  | "agent.task_completed"
  | "company.imported"
  | "error.handler_crash"
  | "goal.created"
  | "install.started"
  | "project.created"
  | "routine.created"
  | "routine.run";

export interface EventDimensionsMap {
  "agent.created": PaperclipAgentCreatedDimensions;
  "agent.task_completed": PaperclipAgentTaskCompletedDimensions;
  "company.imported": PaperclipCompanyImportedDimensions;
  "error.handler_crash": PaperclipErrorHandlerCrashDimensions;
  "goal.created": PaperclipGoalCreatedDimensions;
  "install.started": PaperclipInstallStartedDimensions;
  "project.created": PaperclipProjectCreatedDimensions;
  "routine.created": PaperclipRoutineCreatedDimensions;
  "routine.run": PaperclipRoutineRunDimensions;
}

export const PAPERCLIP_EVENTS = {
  "agent.created": "agent.created",
  "agent.task_completed": "agent.task_completed",
  "company.imported": "company.imported",
  "error.handler_crash": "error.handler_crash",
  "goal.created": "goal.created",
  "install.started": "install.started",
  "project.created": "project.created",
  "routine.created": "routine.created",
  "routine.run": "routine.run",
} as const;

export const PAPERCLIP_ENUM_DESCRIPTIONS = {
  "company.imported": {
    "source_type": {
      "local_path": "Import source came from a filesystem path on the operator's machine.",
      "github": "Import source came from a GitHub repository or GitHub-backed reference."
    }
  },
  "goal.created": {
    "goal_level": {
      "company": "Goal applies at company scope.",
      "team": "Goal applies at team or group scope.",
      "agent": "Goal applies to a specific agent.",
      "task": "Goal applies to task-level work."
    }
  },
  "routine.run": {
    "source": {
      "schedule": "Routine was triggered by a scheduled trigger.",
      "manual": "Routine was triggered manually by a user or agent action.",
      "api": "Routine was triggered through an API request.",
      "webhook": "Routine was triggered by a webhook."
    },
    "status": {
      "received": "Routine run was accepted for processing.",
      "coalesced": "A live execution already existed and the run was coalesced into it.",
      "skipped": "A live execution already existed and concurrency policy skipped the run.",
      "task_created": "Routine dispatch created a new task-execution reference for runner dispatch.",
      "completed": "Routine run completed without needing a new task.",
      "failed": "Routine dispatch failed and the run was finalized as failed."
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
