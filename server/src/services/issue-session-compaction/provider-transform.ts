import type { ProviderModel } from "./types.js";

export const OUTPUT_TOKEN_MAX = 32_000;

export function maxOutputTokens(model: ProviderModel, outputTokenMax = OUTPUT_TOKEN_MAX): number {
  return Math.min(model.limit.output, outputTokenMax) || outputTokenMax;
}
