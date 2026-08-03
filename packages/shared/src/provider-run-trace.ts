/**
 * JSON-compatible values admitted for provider-visible tool inputs/results.
 *
 * Values still pass through the server's recursive redaction and forbidden-key
 * filter before entering this contract. This type does not make arbitrary
 * canonical Session metadata provider-visible.
 */
export type ProviderSafeTraceValue =
  | string
  | number
  | boolean
  | null
  | ProviderSafeTraceValue[]
  | { [key: string]: ProviderSafeTraceValue };

export interface ProviderSafeRunTraceTextPart {
  kind: "text" | "reasoning";
  text: string;
}

export interface ProviderSafeRunTraceToolPart {
  kind: "tool";
  name: string;
  state: "completed" | "error";
  input: ProviderSafeTraceValue;
  result?: ProviderSafeTraceValue;
  errorKind?: string;
}

export type ProviderSafeRunTracePart =
  | ProviderSafeRunTraceTextPart
  | ProviderSafeRunTraceToolPart;

/**
 * One ordered, provider-visible turn. Array order is the chronology contract;
 * canonical Session/message/part/call identifiers and aggregate sequences are
 * intentionally not part of this DTO.
 */
export interface ProviderSafeRunTraceTurn {
  kind: "user" | "synthetic" | "system" | "shell" | "assistant" | "compaction";
  timestamp: string;
  completedAt?: string;
  text?: string;
  content?: ProviderSafeRunTracePart[];
  finish?: string;
  errorKind?: string;
  compactionReason?: "auto" | "manual";
}

export interface ProviderSafeRunOutputCommentReference {
  commentId: string;
}

/**
 * The sole provider-visible run-trace contract shared by the compiled gateway
 * and plugin worker protocol.
 *
 * The canonical trace remains internal and may contain accounting, lineage,
 * Session identities, model switches, checkpoints, and control-plane links.
 * None of those fields are admitted here.
 */
export interface ProviderSafeRunTrace {
  runId: string;
  runKind: "productive" | "consult" | "compaction";
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: "succeeded" | "failed" | null;
  turns: ProviderSafeRunTraceTurn[];
  outputComments: ProviderSafeRunOutputCommentReference[];
  nextCursor: string | null;
}
