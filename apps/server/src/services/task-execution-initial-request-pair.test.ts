import { describe, expect, it } from "vitest";
import {
  classifyOrderedExecutionScopePair,
  type OrderedExecutionScopeMember,
} from "./task-execution-initial-request-pair.js";

type Member = OrderedExecutionScopeMember & {
  readonly id: string;
  readonly sourceKind: string;
  readonly messageKind: "user" | "synthetic";
};

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: "work", executionScopeId: "scope", executionLineageId: "lineage",
    laneOrdinal: 1, sourceKind: "routine_dispatch", messageKind: "user",
    ...overrides,
  };
}

describe("ordered execution-scope pair classification", () => {
  it("uses only the shared scope and instruction/work order", () => {
    const instruction = member({
      id: "instruction", laneOrdinal: 7,
      sourceKind: "system_nudge", messageKind: "user",
    });
    const work = member({ laneOrdinal: 8 });
    expect(classifyOrderedExecutionScopePair([work, instruction])).toEqual({
      instruction,
      work,
    });
  });

  it.each([
    [member({ laneOrdinal: 0 }), member({ id: "second", laneOrdinal: 2 })],
    [member({ laneOrdinal: 0 }), member({ executionScopeId: "other" })],
    [member({ laneOrdinal: 0 }), member({ executionLineageId: "other" })],
  ])("rejects a pair outside one exact ordered scope", (first, second) => {
    expect(classifyOrderedExecutionScopePair([first, second])).toBeNull();
  });
});
