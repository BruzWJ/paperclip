import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Paperclip's five-knob production compaction configuration. */
export const Compaction = Schema.optional(
  Schema.Struct({
    auto: Schema.optional(Schema.Boolean).annotate({
      description: "Enable automatic compaction when context is full (default: true)",
    }),
    prune: Schema.optional(Schema.Boolean).annotate({
      description: "Enable pruning of old tool outputs (default: false)",
    }),
    tail_turns: Schema.optional(NonNegativeInt).annotate({
      description:
        "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
    }),
    preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
      description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
    }),
    reserved: Schema.optional(NonNegativeInt).annotate({
      description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
    }),
  }),
);

export const decodeCompactionConfig = Schema.decodeUnknownSync(Compaction);
