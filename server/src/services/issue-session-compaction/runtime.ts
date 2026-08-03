import { Effect } from "effect";
import { createCompactionAlgorithms } from "./algorithms.js";
import type {
  CompactionCheckpoint,
  CompactionFinalControl,
  CompactionReplayResult,
  CompactionRuntimeDependencies,
} from "./runtime-dependencies.js";
import type {
  Config,
  MessageID,
  ProviderModel,
  ToolPart,
  WithParts,
} from "./types.js";

/**
 * Paperclip's persistence and provider capabilities for session compaction.
 * The algorithm remains deterministic and independent of PostgreSQL details.
 */
export interface IssueSessionCompactionPersistence {
  config(): Promise<Config>;
  messages(sessionId: string): Promise<WithParts[] | undefined>;
  modelForCompaction(input: {
    sessionId: string;
    parentId: MessageID;
  }): Promise<ProviderModel>;
  updateToolPruned(input: {
    sessionId: string;
    part: ToolPart;
    compactedAt: number;
  }): Promise<void>;
  createCompactionRequest(input: {
    sessionId: string;
    agent: string;
    model: { providerID: string; modelID: string };
    auto: boolean;
    overflow: boolean;
  }): Promise<{ parentId: MessageID }>;
  summarize(input: {
    sessionId: string;
    parentId: MessageID;
    prompt: string;
    messages: WithParts[];
    tailStartId?: MessageID;
    previousSummary?: string;
    auto: boolean;
    overflow: boolean;
  }): Promise<CompactionCheckpoint>;
  publishCompactionEnded(input: {
    sessionId: string;
    checkpoint: CompactionCheckpoint;
    control: CompactionFinalControl;
  }): Promise<void>;
  replayOverflow?(input: {
    sessionId: string;
    parentId: MessageID;
    checkpoint: CompactionCheckpoint;
    replay: WithParts;
  }): Promise<CompactionReplayResult>;
  appendSyntheticContinue?(input: {
    sessionId: string;
    checkpoint: CompactionCheckpoint;
    text: string;
  }): Promise<void>;
  outputTokenMax?: number;
}

const fromPromise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (error) => error,
  });

export function compactionRuntimeDependencies(
  persistence: IssueSessionCompactionPersistence,
): CompactionRuntimeDependencies<unknown> {
  return {
    config: () => fromPromise(() => persistence.config()),
    messages: (sessionID) =>
      fromPromise(() => persistence.messages(sessionID)),
    modelForCompaction: ({ sessionID, parentID }) =>
      fromPromise(() =>
        persistence.modelForCompaction({
          sessionId: sessionID,
          parentId: parentID,
        }),
      ),
    updateToolPruned: ({ sessionID, part, compactedAt }) =>
      fromPromise(() =>
        persistence.updateToolPruned({
          sessionId: sessionID,
          part,
          compactedAt,
        }),
      ),
    createCompactionRequest: (input) =>
      fromPromise(async () => {
        const result = await persistence.createCompactionRequest({
          sessionId: input.sessionID,
          agent: input.agent,
          model: input.model,
          auto: input.auto,
          overflow: input.overflow,
        });
        return { parentID: result.parentId };
      }),
    summarize: (input) =>
      fromPromise(() =>
        persistence.summarize({
          sessionId: input.sessionID,
          parentId: input.parentID,
          prompt: input.prompt,
          messages: input.messages,
          tailStartId: input.tailStartID,
          previousSummary: input.previousSummary,
          auto: input.auto,
          overflow: input.overflow,
        }),
      ),
    publishCompactionEnded: ({ sessionID, checkpoint, control }) =>
      fromPromise(() =>
        persistence.publishCompactionEnded({
          sessionId: sessionID,
          checkpoint,
          control,
        }),
      ),
    replayOverflow: ({
      sessionID,
      parentID,
      checkpoint,
      replay,
    }) =>
      persistence.replayOverflow
        ? fromPromise(() =>
            persistence.replayOverflow!({
              sessionId: sessionID,
              parentId: parentID,
              checkpoint,
              replay,
            }),
          )
        : Effect.succeed({ replayMessageId: null }),
    appendSyntheticContinue: ({ sessionID, checkpoint, text }) =>
      persistence.appendSyntheticContinue
        ? fromPromise(() =>
            persistence.appendSyntheticContinue!({
              sessionId: sessionID,
              checkpoint,
              text,
            }),
          )
        : Effect.void,
    outputTokenMax: persistence.outputTokenMax,
  };
}

export function createIssueSessionCompaction(
  persistence: IssueSessionCompactionPersistence,
) {
  const algorithms = createCompactionAlgorithms(
    compactionRuntimeDependencies(persistence),
  );
  return {
    isOverflow: (input: Parameters<typeof algorithms.isOverflow>[0]) =>
      Effect.runPromise(algorithms.isOverflow(input)),
    prune: (input: Parameters<typeof algorithms.prune>[0]) =>
      Effect.runPromise(algorithms.prune(input)),
    process: (input: Parameters<typeof algorithms.process>[0]) =>
      Effect.runPromise(algorithms.process(input)),
    create: (input: Parameters<typeof algorithms.create>[0]) =>
      Effect.runPromise(algorithms.create(input)),
    select: (input: Parameters<typeof algorithms.select>[0]) =>
      Effect.runPromise(algorithms.select(input)),
  };
}

export type {
  CompactionCheckpoint,
  CompactionFinalControl,
} from "./runtime-dependencies.js";
