export { TelemetryClient } from "./client.js";
export { resolveTelemetryConfig, resolveCaps, TELEMETRY_DEFAULTS } from "./config.js";
export type { TelemetryConfigOverrides } from "./config.js";
export { loadOrCreateState } from "./state.js";
export {
  trackInstallStarted,
  trackCompanyImported,
  trackProjectCreated,
  trackRoutineCreated,
  trackRoutineRun,
  trackGoalCreated,
  trackAgentCreated,
  trackAgentTaskCompleted,
  trackErrorHandlerCrash,
} from "./events.js";
export type {
  TelemetryConfig,
  TelemetryBackoffConfig,
  TelemetryState,
  TelemetryEvent,
  TelemetryEventEnvelope,
  TelemetryDimensions,
  TelemetryDimensionValue,
  TelemetryEventDimensions,
  TelemetryEventName,
} from "./types.js";
export type {
  AnyPaperclipTelemetryEvent,
  EventDimensionsMap,
  PaperclipEventName,
} from "./generated/paperclip-telemetry.js";
