import { Effect } from "effect";
import {
  experimentalChatMessagesTransform,
  experimentalCompactionAutocontinue,
  experimentalSessionCompacting,
} from "./policy.js";
import { buildPrompt } from "./build-prompt.js";
import type {
  CompactionFinalControl,
  CompactionRuntimeDependencies,
} from "./runtime-dependencies.js";
import { isMedia } from "./media.js";
import { isOverflow as overflow, usable } from "./overflow.js";
import { estimate as estimateTokens } from "./token.js";
import {
  buildCompactionPrompt,
  serializeCompactionTranscript,
} from "./transcript.js";
import type {
  CompactionPart,
  Config,
  MessageID,
  MessagePart,
  ProviderModel,
  TokenUsage,
  ToolPart,
  UserMessageInfo,
  WithParts,
} from "./types.js";

export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
const PRUNE_PROTECTED_TOOLS = ["skill"];
const DEFAULT_TAIL_TURNS = 2;
const MIN_PRESERVE_RECENT_TOKENS = 2_000;
const MAX_PRESERVE_RECENT_TOKENS = 8_000;
type Turn = {
  start: number;
  end: number;
  id: MessageID;
};

type Tail = {
  start: number;
  id: MessageID;
};

type CompletedCompaction = {
  userIndex: number;
  assistantIndex: number;
  summary: string | undefined;
};

function summaryText(message: WithParts) {
  const text = message.parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || undefined;
}

function completedCompactions(messages: WithParts[]) {
  const users = new Map<MessageID, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.info.role !== "user") continue;
    if (!msg.parts.some((part) => part.type === "compaction")) continue;
    users.set(msg.info.id, i);
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return [];
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return [];
    const userIndex = users.get(msg.info.parentID!);
    if (userIndex === undefined) return [];
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }];
  });
}

function preserveRecentBudget(input: { cfg: Config; model: ProviderModel }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  );
}

function turns(messages: WithParts[]) {
  const result: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.info.role !== "user") continue;
    if (msg.parts.some((part) => part.type === "compaction")) continue;
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    });
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i]!.end = result[i + 1]!.start;
  }
  return result;
}

function splitTurn(input: {
  messages: WithParts[];
  turn: Turn;
  budget: number;
  estimate: (input: { messages: WithParts[] }) => Effect.Effect<number, unknown>;
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined;
    if (input.turn.end - input.turn.start <= 1) return undefined;
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
      });
      if (size > input.budget) continue;
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail;
    }
    return undefined;
  });
}

export class CompactionContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

export function createCompactionAlgorithms<E>(
  dependencies: CompactionRuntimeDependencies<E>,
) {
  const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
    tokens: TokenUsage;
    model: ProviderModel;
  }) {
    return overflow({
      cfg: yield* dependencies.config(),
      tokens: input.tokens,
      model: input.model,
      outputTokenMax: dependencies.outputTokenMax,
    });
  });

  const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
    messages: WithParts[];
  }) {
    return estimateTokens(
      serializeCompactionTranscript(input.messages, {
        transformForPrompt: false,
      }),
    );
  });

  const select = Effect.fn("SessionCompaction.select")(function* (input: {
    messages: WithParts[];
    cfg: Config;
    model: ProviderModel;
  }) {
    const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS;
    if (limit <= 0) return { head: input.messages, tail_start_id: undefined };
    const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model });
    const all = turns(input.messages);
    if (!all.length) return { head: input.messages, tail_start_id: undefined };
    const recent = all.slice(-limit);
    const sizes = yield* Effect.forEach(
      recent,
      (turn) =>
        estimate({
          messages: input.messages.slice(turn.start, turn.end),
        }),
      { concurrency: 1 },
    );

    let total = 0;
    let keep: Tail | undefined;
    for (let i = recent.length - 1; i >= 0; i--) {
      const turn = recent[i]!;
      const size = sizes[i]!;
      if (total + size <= budget) {
        total += size;
        keep = { start: turn.start, id: turn.id };
        continue;
      }
      const remaining = budget - total;
      const split = yield* splitTurn({
        messages: input.messages,
        turn,
        budget: remaining,
        estimate,
      });
      if (split) keep = split;
      else if (!keep) {
        yield* Effect.logInfo("tail fallback", { budget, size, total });
      }
      break;
    }

    if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined };
    return {
      head: input.messages.slice(0, keep.start),
      tail_start_id: keep.id,
    };
  });

  // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
  // calls, then erases output of older tool calls to free context space
  const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: string }) {
    const cfg = yield* dependencies.config();
    if (!cfg.compaction?.prune) return;
    yield* Effect.logInfo("pruning");

    const msgs = yield* dependencies.messages(input.sessionID);
    if (!msgs) return;

    let total = 0;
    let pruned = 0;
    const toPrune: ToolPart[] = [];
    let turns = 0;

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]!;
      if (msg.info.role === "user") turns++;
      if (turns < 2) continue;
      if (msg.info.role === "assistant" && msg.info.summary) break loop;
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]!;
        if (part.type !== "tool") continue;
        if (part.state.status !== "completed") continue;
        if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue;
        if (part.state.time.compacted) break loop;
        const estimate = estimateTokens(part.state.output);
        total += estimate;
        if (total <= PRUNE_PROTECT) continue;
        pruned += estimate;
        toPrune.push(part);
      }
    }

    yield* Effect.logInfo("found", { pruned, total });
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now();
          yield* dependencies.updateToolPruned({
            sessionID: input.sessionID,
            part,
            compactedAt: part.state.time.compacted,
          });
        }
      }
      yield* Effect.logInfo("pruned", { count: toPrune.length });
    }
  });

  const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
    parentID: MessageID;
    messages: WithParts[];
    sessionID: string;
    auto: boolean;
    overflow?: boolean;
  }) {
    const parent = input.messages.findLast((m) => m.info.id === input.parentID);
    if (!parent || parent.info.role !== "user") {
      throw new Error(`Compaction parent must be a user message: ${input.parentID}`);
    }
    const userMessage = parent.info;
    const compactionPart = parent.parts.find((part): part is CompactionPart => part.type === "compaction");

    let messages = input.messages;
    let replay:
      | {
          info: UserMessageInfo;
          parts: MessagePart[];
        }
      | undefined;
    if (input.overflow) {
      const idx = input.messages.findIndex((m) => m.info.id === input.parentID);
      for (let i = idx - 1; i >= 0; i--) {
        const msg = input.messages[i]!;
        if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
          replay = { info: msg.info, parts: msg.parts };
          messages = input.messages.slice(0, i);
          break;
        }
      }
      const hasContent =
        replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"));
      if (!hasContent) {
        replay = undefined;
        messages = input.messages;
      }
    }

    const model = yield* dependencies.modelForCompaction({
      sessionID: input.sessionID,
      parentID: input.parentID,
    });
    const cfg = yield* dependencies.config();
    const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages;
    const prior = completedCompactions(history);
    const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]));
    const previousSummary = prior.at(-1)?.summary;
    const selected = yield* select({
      messages: history.filter((_, index) => !hidden.has(index)),
      cfg,
      model,
    });
    // Paperclip's prompt policy supplies no extra context and does not replace the anchored prompt.
    const compacting = experimentalSessionCompacting();
    const msgs = structuredClone(selected.head);
    const transformed = experimentalChatMessagesTransform(msgs);
    const instruction =
      compacting.prompt ??
      buildPrompt({ previousSummary, context: compacting.context });
    const prompt = buildCompactionPrompt({
      messages: transformed,
      instruction,
    });
    const checkpoint = yield* dependencies.summarize({
      sessionID: input.sessionID,
      parentID: input.parentID,
      prompt,
      messages: transformed,
      tailStartID: selected.tail_start_id,
      previousSummary,
      auto: input.auto,
      overflow: input.overflow === true,
    });
    const result = checkpoint.result ?? "continue";

    if (result === "compact") {
      throw new CompactionContextOverflowError(
        replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media",
      );
    }

    if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
      compactionPart.tail_start_id = selected.tail_start_id;
    }

    const postCheckpointAction =
      result !== "continue" || !input.auto
        ? "none"
        : replay
          ? "overflow-replay"
          : experimentalCompactionAutocontinue().enabled
            ? "auto-continue"
            : "none";

    // The checkpoint is the durable boundary. Persist the selected
    // post-checkpoint action before its replay or continuation can become
    // lowerable, so recovery never has to infer intent from missing rows.
    if (result === "continue") {
      yield* dependencies.publishCompactionEnded({
        sessionID: input.sessionID,
        checkpoint,
        control: { postCheckpointAction, replayMessageId: null },
      });
    }

    if (result === "continue") {
      if (postCheckpointAction === "overflow-replay" && replay) {
        const replayParts = replay.parts.flatMap((part): MessagePart[] => {
          if (part.type === "compaction") return [];
          return [
            part.type === "file" && isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part,
          ];
        });
        yield* dependencies.replayOverflow({
          sessionID: input.sessionID,
          parentID: input.parentID,
          checkpoint,
          replay: {
            info: replay.info,
            parts: replayParts,
          },
        });
      }

      if (postCheckpointAction === "auto-continue") {
        const text =
          (input.overflow
            ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
            : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
        yield* dependencies.appendSyntheticContinue({
          sessionID: input.sessionID,
          checkpoint,
          text,
        });
      }
    }

    if (result === "stop") return "stop";
    return result;
  });

  const create = Effect.fn("SessionCompaction.create")(function* (input: {
    sessionID: string;
    agent: string;
    model: { providerID: string; modelID: string };
    auto: boolean;
    overflow?: boolean;
  }) {
    yield* dependencies.createCompactionRequest({
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model,
      auto: input.auto,
      overflow: input.overflow === true,
    });
  });

  return {
    isOverflow,
    prune,
    process: processCompaction,
    create,
    select,
  };
}
