import type {
  AcpLivePlanEntry,
  NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acp-subprocess";
import { redactSensitiveText } from "../redaction.js";
import { publishLiveEvent } from "./live-events.js";

export interface RoutedAcpPromptIdentity {
  companyId: string;
  issueId: string;
  runId: string;
  refId: string;
  runOrdinal: number;
  segmentOrdinal: number;
  attemptId: string;
  capabilityGenerationId: string;
}

export interface CurrentAcpPromptIdentity extends RoutedAcpPromptIdentity {
  promptState: "prompt_active";
}

export interface IssueExecutionPlanPublicationRedactor {
  redactText(value: string): string;
}

export class IssueExecutionLivePlanViolation extends Error {
  readonly code = "issue_execution_live_plan_violation";

  constructor(message: string) {
    super(message);
    this.name = "IssueExecutionLivePlanViolation";
  }
}

const PLAN_ENTRY_KEYS = new Set(["content", "priority", "status"]);
const PLAN_PRIORITIES = new Set(["high", "medium", "low"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validateRoute(route: RoutedAcpPromptIdentity): void {
  if (
    !validIdentity(route.companyId) ||
    !validIdentity(route.issueId) ||
    !validIdentity(route.runId) ||
    !validIdentity(route.refId) ||
    !validIdentity(route.attemptId) ||
    !validIdentity(route.capabilityGenerationId) ||
    !Number.isSafeInteger(route.runOrdinal) ||
    route.runOrdinal < 0 ||
    !Number.isSafeInteger(route.segmentOrdinal) ||
    route.segmentOrdinal < 0
  ) {
    throw new IssueExecutionLivePlanViolation(
      "Stable ACP plan has a malformed routed prompt identity",
    );
  }
}

function samePrompt(
  routed: RoutedAcpPromptIdentity,
  current: CurrentAcpPromptIdentity,
): boolean {
  return (
    routed.companyId === current.companyId &&
    routed.issueId === current.issueId &&
    routed.runId === current.runId &&
    routed.refId === current.refId &&
    routed.runOrdinal === current.runOrdinal &&
    routed.segmentOrdinal === current.segmentOrdinal &&
    routed.attemptId === current.attemptId &&
    routed.capabilityGenerationId === current.capabilityGenerationId
  );
}

function validatePlanEntry(value: AcpLivePlanEntry): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== PLAN_ENTRY_KEYS.size ||
    Object.keys(value).some((key) => !PLAN_ENTRY_KEYS.has(key)) ||
    typeof value.content !== "string" ||
    !PLAN_PRIORITIES.has(value.priority) ||
    !PLAN_STATUSES.has(value.status)
  ) {
    throw new IssueExecutionLivePlanViolation(
      "Stable ACP plan contains a malformed entry",
    );
  }
}

/**
 * Publish one stable ACP full-plan replacement from the exact live prompt.
 *
 * The caller supplies the connection-bound routed identity and a separately
 * resolved current control-plane snapshot. This boundary retains no plan or
 * routing cache: mismatch, non-active prompt state, malformed input, or
 * redaction failure publishes nothing.
 */
export function publishIssueExecutionLivePlan(input: {
  routedPrompt: RoutedAcpPromptIdentity;
  currentPrompt: CurrentAcpPromptIdentity;
  event: NormalizedAcpSessionEvent;
  redactor: IssueExecutionPlanPublicationRedactor;
}) {
  validateRoute(input.routedPrompt);
  validateRoute(input.currentPrompt);
  if (input.currentPrompt.promptState !== "prompt_active") {
    throw new IssueExecutionLivePlanViolation(
      "Stable ACP plan arrived outside an active prompt",
    );
  }
  if (!samePrompt(input.routedPrompt, input.currentPrompt)) {
    throw new IssueExecutionLivePlanViolation(
      "Stable ACP plan does not match the current routed prompt",
    );
  }
  if (input.event.kind !== "plan") {
    throw new IssueExecutionLivePlanViolation(
      "Only the stable anonymous ACP plan update may be published",
    );
  }
  if (!Array.isArray(input.event.entries)) {
    throw new IssueExecutionLivePlanViolation(
      "Stable ACP plan replacement must be an array",
    );
  }

  const replacement = input.event.entries.map((entry) => {
    validatePlanEntry(entry);
    return {
      content: redactSensitiveText(input.redactor.redactText(entry.content)),
      priority: entry.priority,
      status: entry.status,
    };
  });

  return publishLiveEvent({
    companyId: input.routedPrompt.companyId,
    type: "issue.execution.plan.live",
    payload: {
      companyId: input.routedPrompt.companyId,
      issueId: input.routedPrompt.issueId,
      runId: input.routedPrompt.runId,
      refId: input.routedPrompt.refId,
      runOrdinal: input.routedPrompt.runOrdinal,
      segmentOrdinal: input.routedPrompt.segmentOrdinal,
      replacement,
    },
  });
}
