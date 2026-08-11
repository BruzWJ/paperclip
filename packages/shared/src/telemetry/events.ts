import type { TelemetryClient } from "./client.js";
import type { EventDimensionsMap } from "./generated/paperclip-telemetry.js";

type RawDimension<T extends string | undefined> = T | (string & {});

function asEventDimension<T extends string>(value: RawDimension<T>): T {
  return value as T;
}

export function trackInstallStarted(client: TelemetryClient): void {
  client.track("install.started", {});
}

export function trackInstallCompleted(
  client: TelemetryClient,
  dims: { adapterType: RawDimension<EventDimensionsMap["install.completed"]["adapter_type"]> },
): void {
  client.track("install.completed", {
    adapter_type: asEventDimension(dims.adapterType),
  });
}

export function trackCompanyImported(
  client: TelemetryClient,
  dims: {
    sourceType: RawDimension<EventDimensionsMap["company.imported"]["source_type"]>;
    sourceRef: string;
    isPrivate: boolean;
  },
): void {
  const ref = dims.isPrivate ? client.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  client.track("company.imported", {
    source_type: asEventDimension(dims.sourceType),
    source_ref: ref,
    source_ref_hashed: dims.isPrivate,
  });
}

export function trackProjectCreated(client: TelemetryClient): void {
  client.track("project.created", {});
}

export function trackRoutineCreated(client: TelemetryClient): void {
  client.track("routine.created", {});
}

export function trackRoutineRun(
  client: TelemetryClient,
  dims: {
    source: RawDimension<EventDimensionsMap["routine.run"]["source"]>;
    status: RawDimension<EventDimensionsMap["routine.run"]["status"]>;
  },
): void {
  client.track("routine.run", {
    source: asEventDimension(dims.source),
    status: asEventDimension(dims.status),
  });
}

export function trackGoalCreated(
  client: TelemetryClient,
  dims?: { goalLevel?: RawDimension<EventDimensionsMap["goal.created"]["goal_level"]> | null },
): void {
  client.track("goal.created", {
    goal_level: dims?.goalLevel ? asEventDimension(dims.goalLevel) : "other",
  });
}

export function trackAgentCreated(
  client: TelemetryClient,
  dims: { agentId: string },
): void {
  client.track("agent.created", {
    agent_id: dims.agentId,
  });
}

export function trackSkillImported(
  client: TelemetryClient,
  dims: {
    sourceType: RawDimension<EventDimensionsMap["skill.imported"]["source_type"]>;
    skillRef?: string | null;
  },
): void {
  client.track("skill.imported", {
    source_type: asEventDimension(dims.sourceType),
    ...(dims.skillRef ? { skill_ref: dims.skillRef } : {}),
  });
}

export function trackAgentTaskCompleted(
  client: TelemetryClient,
  dims: {
    agentId: string;
    adapterType: RawDimension<EventDimensionsMap["agent.task_completed"]["adapter_type"]>;
    model?: string;
  },
): void {
  client.track("agent.task_completed", {
    agent_id: dims.agentId,
    adapter_type: asEventDimension(dims.adapterType),
    ...(dims.model ? { model: dims.model } : {}),
  });
}

export function trackErrorHandlerCrash(
  client: TelemetryClient,
  dims: { errorCode: string },
): void {
  client.track("error.handler_crash", { error_code: dims.errorCode });
}
