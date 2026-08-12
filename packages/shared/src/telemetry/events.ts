import type { TelemetryClient } from "./client.js";
import type { EventDimensionsMap } from "./generated/paperclip-telemetry.js";

export function trackInstallStarted(client: TelemetryClient): void {
  client.track("install.started", {});
}

export function trackCompanyImported(
  client: TelemetryClient,
  dims: {
    sourceType: EventDimensionsMap["company.imported"]["source_type"];
    sourceRef: string;
    isPrivate: boolean;
  },
): void {
  const ref = dims.isPrivate ? client.hashPrivateRef(dims.sourceRef) : dims.sourceRef;
  client.track("company.imported", {
    source_type: dims.sourceType,
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
    source: EventDimensionsMap["routine.run"]["source"];
    status: EventDimensionsMap["routine.run"]["status"];
  },
): void {
  client.track("routine.run", {
    source: dims.source,
    status: dims.status,
  });
}

export function trackGoalCreated(
  client: TelemetryClient,
  dims: { goalLevel: EventDimensionsMap["goal.created"]["goal_level"] },
): void {
  client.track("goal.created", {
    goal_level: dims.goalLevel,
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

export function trackAgentTaskCompleted(
  client: TelemetryClient,
  dims: {
    agentId: string;
    adapterType: EventDimensionsMap["agent.task_completed"]["adapter_type"];
    model?: string;
  },
): void {
  client.track("agent.task_completed", {
    agent_id: dims.agentId,
    adapter_type: dims.adapterType,
    ...(dims.model ? { model: dims.model } : {}),
  });
}

export function trackErrorHandlerCrash(
  client: TelemetryClient,
  dims: { errorCode: string },
): void {
  client.track("error.handler_crash", { error_code: dims.errorCode });
}
