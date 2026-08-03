import type { Effect } from "effect";
import type {
  Config,
  MessageID,
  ProviderModel,
  ToolPart,
  WithParts,
} from "./types.js";

export interface CompactionCheckpoint {
  requestMessageId: MessageID;
  summaryMessageId: MessageID;
  tailStartId?: MessageID;
  result?: "continue" | "compact" | "stop";
}

export type CompactionPostCheckpointAction =
  | "none"
  | "overflow-replay"
  | "auto-continue";

export interface CompactionFinalControl {
  /** Durable post-checkpoint work selected before the checkpoint is published. */
  postCheckpointAction: CompactionPostCheckpointAction;
  replayMessageId: MessageID | null;
}

/** Result of appending (or reusing) the post-checkpoint overflow replay. */
export interface CompactionReplayResult {
  replayMessageId: MessageID | null;
}

/**
 * Paperclip-owned effects required by the compaction algorithms. Persistence,
 * model invocation, and durable event publication stay behind these explicit
 * capabilities.
 */
export interface CompactionRuntimeDependencies<E = unknown> {
  readonly config: () => Effect.Effect<Config, E>;
  readonly messages: (
    sessionID: string,
  ) => Effect.Effect<WithParts[] | undefined, E>;
  readonly modelForCompaction: (input: {
    readonly sessionID: string;
    readonly parentID: MessageID;
  }) => Effect.Effect<ProviderModel, E>;
  readonly updateToolPruned: (input: {
    readonly sessionID: string;
    readonly part: ToolPart;
    readonly compactedAt: number;
  }) => Effect.Effect<void, E>;
  readonly createCompactionRequest: (input: {
    readonly sessionID: string;
    readonly agent: string;
    readonly model: {
      readonly providerID: string;
      readonly modelID: string;
    };
    readonly auto: boolean;
    readonly overflow: boolean;
  }) => Effect.Effect<{ readonly parentID: MessageID }, E>;
  readonly summarize: (input: {
    readonly sessionID: string;
    readonly parentID: MessageID;
    readonly prompt: string;
    readonly messages: WithParts[];
    readonly tailStartID?: MessageID;
    readonly previousSummary?: string;
    readonly auto: boolean;
    readonly overflow: boolean;
  }) => Effect.Effect<CompactionCheckpoint, E>;
  readonly publishCompactionEnded: (input: {
    readonly sessionID: string;
    readonly checkpoint: CompactionCheckpoint;
    readonly control: CompactionFinalControl;
  }) => Effect.Effect<void, E>;
  readonly replayOverflow: (input: {
    readonly sessionID: string;
    readonly parentID: MessageID;
    readonly checkpoint: CompactionCheckpoint;
    readonly replay: WithParts;
  }) => Effect.Effect<CompactionReplayResult, E>;
  readonly appendSyntheticContinue: (input: {
    readonly sessionID: string;
    readonly checkpoint: CompactionCheckpoint;
    readonly text: string;
  }) => Effect.Effect<void, E>;
  readonly outputTokenMax?: number;
}
