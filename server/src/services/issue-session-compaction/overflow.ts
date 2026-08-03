import { maxOutputTokens } from "./provider-transform.js";
import type { Config, ProviderModel, TokenUsage } from "./types.js";

const COMPACTION_BUFFER = 20_000;

export function usable(input: { cfg: Config; model: ProviderModel; outputTokenMax?: number }) {
  const context = input.model.limit.context;
  if (context === 0) return 0;

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, maxOutputTokens(input.model, input.outputTokenMax));
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - maxOutputTokens(input.model, input.outputTokenMax));
}

export function isOverflow(input: {
  cfg: Config;
  tokens: TokenUsage;
  model: ProviderModel;
  outputTokenMax?: number;
}) {
  if (input.cfg.compaction?.auto === false) return false;
  if (input.model.limit.context === 0) return false;

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write;
  return count >= usable(input);
}
