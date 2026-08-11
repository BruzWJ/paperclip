import { describe, expect, it } from "vitest";
import { preserveCorrelationAfterNonProtocolClosure } from "./task-execution-correlation-retention.js";

describe("task-execution correlation retention", () => {
  it.each([
    { turn: "work", carryContext: true, expected: true },
    { turn: "work", carryContext: false, expected: false },
    { turn: "bootstrap", carryContext: true, expected: false },
    { turn: "bootstrap", carryContext: false, expected: false },
  ] as const)(
    "returns $expected for $turn with carry_context=$carryContext",
    ({ turn, carryContext, expected }) => {
      expect(preserveCorrelationAfterNonProtocolClosure({
        turn,
        carryContext,
      })).toBe(expected);
    },
  );
});
