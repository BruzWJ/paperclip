import type { RuntimeToolTurn } from "./runtime-interface-compiler.js";

/**
 * A failed ordinary work turn does not prove that ACPX lost its backend
 * session. Preserve exact same-issue continuity only when the frozen runtime
 * interface authorized carry for a work turn. Bootstrap and false-carry
 * correlations are bounded to that failed prompt and must be superseded.
 */
export function preserveCorrelationAfterNonProtocolClosure(input: {
  readonly turn: RuntimeToolTurn;
  readonly carryContext: boolean;
}): boolean {
  return input.turn === "work" && input.carryContext;
}
