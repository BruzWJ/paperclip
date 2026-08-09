import type {
  AgentVisibleIssueStatus,
  IssueExecutionRunStatus,
  RunLivenessState,
} from "@paperclipai/shared";

export type RunLivenessActionability =
  | "runnable"
  | "manager_review"
  | "blocked_external"
  | "approval_required"
  | "unknown";

export interface RunLivenessEvidenceInput {
  documentRevisionsCreated: number;
  planDocumentRevisionsCreated: number;
  workProductsCreated: number;
  activityEventsCreated: number;
  toolOrActionEventsCreated: number;
  latestEvidenceAt: Date | null;
}

export interface RunLivenessClassificationInput {
  runStatus: IssueExecutionRunStatus;
  /** Typed lifecycle fact read inside canonical finalization. */
  issueLifecycleStatus: AgentVisibleIssueStatus;
  /** Canonical completed Session assistant text parts for this exact run. */
  assistantTextParts: readonly string[];
  /** Typed terminal facts; never projected comments or process output. */
  failureFacts: {
    terminalReasonCode: string;
    assistantErrors: readonly {
      type: string;
    }[];
  };
  continuationAttempt?: number | null;
  evidence?: Partial<RunLivenessEvidenceInput> | null;
}

export interface RunLivenessClassification {
  livenessState: RunLivenessState;
  livenessReason: string;
  continuationAttempt: number;
  lastUsefulActionAt: Date | null;
  nextAction: string | null;
  actionability: RunLivenessActionability;
}

const PLANNING_ONLY_RE =
  /\b(?:i(?:'ll| will| am going to|'m going to)|let me|i need to|next(?:,| i will| i'll)?|my next step is|the next step is)\s+(?:first\s+)?(?:inspect|check|review|look|investigate|analy[sz]e|open|read|start|begin|work on|implement|fix|test|update|create|add)\b/i;
const NEXT_STEPS_RE = /^\s*(?:next steps?|plan)\s*:/im;
const BLOCKER_RE =
  /\b(?:blocked|can't proceed|cannot proceed|unable to proceed|waiting on|need(?:s|ed)? .{0,80}\b(?:approval|access|credential|credentials|secret|api key|token|input|clarification)|requires? .{0,80}\b(?:approval|access|credential|credentials|secret|api key|token|input|clarification))\b/i;
const NEGATED_BLOCKER_RE = /\b(?:not blocked|no blocker|no blockers|unblocked)\b/i;
const APPROVAL_REQUIRED_RE =
  /\b(?:approval required|requires? .{0,80}\bapproval|need(?:s|ed)? .{0,80}\bapproval|waiting on .{0,80}\bapproval|pending approval|board approval|human approval|user approval|operator approval)\b/i;
const EXTERNAL_BLOCKER_RE =
  /\b(?:can't proceed|cannot proceed|unable to proceed|waiting on|blocked by|blocked on|need(?:s|ed)?|requires?) .{0,120}\b(?:access|credential|credentials|secret|secrets|api key|token|password|login|account|permission|permissions|input|clarification)\b/i;
const MANAGER_REVIEW_RE =
  /\b(?:manager review|human review|manual review|security review|escalate|production deploy|deploy(?:ing)? to production|deploy(?:ing)? to prod|prod deploy|production access|rotate .{0,40}\b(?:secret|key|token)|delete .{0,40}\bproduction|security-sensitive|credentialed operation|budget-sensitive|cost approval|spend approval)\b/i;
const RUNNABLE_RE =
  /\b(?:(?:run|rerun|execute)\s+(?:pnpm|npm|yarn|bun|vitest|jest|pytest|cargo|go test|curl|tests?|typecheck|build|lint|package|verification)|(?:inspect|check|review|look|investigate|analy[sz]e|open|read|start|begin|continue|implement|fix|test|update|create|add|write|verify|validate|report)\b)/i;
const UNMANAGED_BACKGROUND_TASK_STOP_REASON = "unmanaged_background_task_stopped";
const UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON = "unmanaged background task stopped; no durable live path";

function compactReason(reason: string) {
  return reason.length <= 500 ? reason : `${reason.slice(0, 497)}...`;
}

function normalizeCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeContinuationAttempt(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assistantText(input: RunLivenessClassificationInput) {
  return input.assistantTextParts
    .map(readText)
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
}

export function hasUsefulOutput(input: RunLivenessClassificationInput) {
  return assistantText(input).length > 0;
}

export function declaredBlocker(input: RunLivenessClassificationInput) {
  if (input.issueLifecycleStatus === "blocked") return true;
  const actionability = classifyRunActionability(input);
  return actionability === "blocked_external" || actionability === "approval_required";
}

export function looksLikePlanningOnly(input: RunLivenessClassificationInput) {
  const text = assistantText(input);
  if (!text) return false;
  return PLANNING_ONLY_RE.test(text) || NEXT_STEPS_RE.test(text) || /^\s*next(?: steps?| action)?\s*:/im.test(text);
}

function normalizeEvidence(evidence: Partial<RunLivenessEvidenceInput> | null | undefined): RunLivenessEvidenceInput {
  return {
    documentRevisionsCreated: normalizeCount(evidence?.documentRevisionsCreated),
    planDocumentRevisionsCreated: normalizeCount(evidence?.planDocumentRevisionsCreated),
    workProductsCreated: normalizeCount(evidence?.workProductsCreated),
    activityEventsCreated: normalizeCount(evidence?.activityEventsCreated),
    toolOrActionEventsCreated: normalizeCount(evidence?.toolOrActionEventsCreated),
    latestEvidenceAt: evidence?.latestEvidenceAt instanceof Date ? evidence.latestEvidenceAt : null,
  };
}

export function hasConcreteActionEvidence(evidence: Partial<RunLivenessEvidenceInput> | null | undefined) {
  const normalized = normalizeEvidence(evidence);
  // Workspace creation is setup evidence, not issue progress by itself. It can
  // appear in reasons alongside durable activity, but it must not prevent a
  // planning-only or empty run from receiving a bounded continuation.
  return (
    normalized.documentRevisionsCreated +
      normalized.planDocumentRevisionsCreated +
      normalized.workProductsCreated +
      normalized.activityEventsCreated +
      normalized.toolOrActionEventsCreated >
    0
  );
}

function evidenceReason(evidence: RunLivenessEvidenceInput) {
  const parts: string[] = [];
  if (evidence.documentRevisionsCreated > 0) parts.push(`${evidence.documentRevisionsCreated} document revision(s)`);
  if (evidence.workProductsCreated > 0) parts.push(`${evidence.workProductsCreated} work product(s)`);
  if (evidence.activityEventsCreated > 0) parts.push(`${evidence.activityEventsCreated} activity event(s)`);
  if (evidence.toolOrActionEventsCreated > 0) parts.push(`${evidence.toolOrActionEventsCreated} tool/action event(s)`);
  return parts.join(", ");
}

function stripMarkdownListPrefix(line: string) {
  return line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim();
}

function nextNonNoiseLine(lines: string[], startIndex: number) {
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = stripMarkdownListPrefix(lines[i] ?? "");
    if (!line) continue;
    return line;
  }
  return null;
}

function extractNextActionFromText(text: string) {
  const lines = text.split(/\r?\n/).map((entry) => entry.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    if (!rawLine) continue;
    const line = stripMarkdownListPrefix(rawLine);
    const labeled = line.match(/^next(?: steps?| action)?\s*:\s*(.*)$/i);
    if (labeled) {
      const sameLine = stripMarkdownListPrefix(labeled[1] ?? "");
      return sameLine || nextNonNoiseLine(lines, i);
    }
    if (PLANNING_ONLY_RE.test(line)) return line;
  }
  return null;
}

function extractNextAction(input: RunLivenessClassificationInput) {
  const candidates = input.assistantTextParts.filter(
    (value): value is string => Boolean(readText(value)),
  );

  for (const candidate of candidates) {
    const line = extractNextActionFromText(candidate);
    if (!line) continue;
    return line.length <= 500 ? line : `${line.slice(0, 497)}...`;
  }
  return null;
}

export function classifyRunActionability(input: RunLivenessClassificationInput): RunLivenessActionability {
  const text = assistantText(input);
  if (!text) return "unknown";
  if (NEGATED_BLOCKER_RE.test(text)) {
    return RUNNABLE_RE.test(text) ? "runnable" : "unknown";
  }
  if (APPROVAL_REQUIRED_RE.test(text)) return "approval_required";
  if (EXTERNAL_BLOCKER_RE.test(text) || BLOCKER_RE.test(text) && /\b(?:credential|secret|api key|token|access|input|clarification)\b/i.test(text)) {
    return "blocked_external";
  }
  if (MANAGER_REVIEW_RE.test(text)) return "manager_review";
  if (RUNNABLE_RE.test(text)) return "runnable";
  return "unknown";
}

export function classifyRunLiveness(input: RunLivenessClassificationInput): RunLivenessClassification {
  const evidence = normalizeEvidence(input.evidence);
  const continuationAttempt = normalizeContinuationAttempt(input.continuationAttempt);
  const actionability = classifyRunActionability(input);
  const nextAction = extractNextAction(input);
  const issueStatus = input.issueLifecycleStatus;
  const usefulOutput = hasUsefulOutput(input);
  const concreteEvidence = hasConcreteActionEvidence(evidence);
  const lastUsefulActionAt = concreteEvidence ? evidence.latestEvidenceAt : null;

  const output = (state: RunLivenessState, reason: string, nextAction: string | null = null): RunLivenessClassification => ({
    livenessState: state,
    livenessReason: compactReason(reason),
    continuationAttempt,
    lastUsefulActionAt: state === "advanced" || state === "completed" || state === "blocked" ? lastUsefulActionAt : null,
    nextAction,
    actionability,
  });

  if (input.runStatus === "interrupted") {
    return output(
      "needs_followup",
      `Run interrupted (${input.failureFacts.terminalReasonCode})`,
    );
  }

  if (input.runStatus !== "succeeded") {
    if (
      input.failureFacts.terminalReasonCode ===
      UNMANAGED_BACKGROUND_TASK_STOP_REASON
    ) {
      return output("failed", UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON);
    }
    const errorTypes = [
      ...new Set(input.failureFacts.assistantErrors.map((error) => error.type)),
    ];
    const errorSuffix = errorTypes.length > 0
      ? `; assistant error ${errorTypes.join(", ")}`
      : "";
    return output(
      "failed",
      `Run ended with ${input.runStatus} (${input.failureFacts.terminalReasonCode}${errorSuffix})`,
    );
  }

  if (issueStatus === "done" || issueStatus === "cancelled") {
    return output("completed", `Issue is ${issueStatus}`);
  }

  if (declaredBlocker(input)) {
    return output("blocked", issueStatus === "blocked" ? "Issue status is blocked" : "Run output declared a concrete blocker", nextAction);
  }

  if (!usefulOutput && !concreteEvidence) {
    return output("empty_response", "Run succeeded without useful output or concrete action evidence");
  }

  if (concreteEvidence) {
    return output("advanced", `Run produced concrete action evidence: ${evidenceReason(evidence)}`);
  }

  if (looksLikePlanningOnly(input) || nextAction) {
    if (actionability === "runnable") {
      return output("plan_only", "Run described runnable future work without concrete action evidence", nextAction);
    }
    return output("needs_followup", "Run described future work that is not safe to auto-continue", nextAction);
  }

  if (usefulOutput) {
    return output("needs_followup", "Run produced useful output but no concrete action evidence", nextAction);
  }

  return output("empty_response", "Run succeeded without useful output");
}
