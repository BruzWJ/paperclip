import { describe, expect, it } from "vitest";
import {
  ISSUE_BOARD_REOPEN_DISPATCH_KINDS,
  type IssueBoardReopenDispatch,
} from "./issue-runtime.js";

describe("canonical board reopen dispatch contract", () => {
  it("contains only the exact provider and provider-free branches", () => {
    expect(ISSUE_BOARD_REOPEN_DISPATCH_KINDS).toEqual([
      "agent_execution",
      "board_only",
    ]);

    const branches = [
      {
        kind: "agent_execution",
        executionRef: { id: "ref-1" },
      },
      { kind: "board_only" },
    ] as const satisfies readonly (
      | Pick<
          Extract<IssueBoardReopenDispatch, { kind: "agent_execution" }>,
          "kind"
        > & { executionRef: { id: string } }
      | Extract<IssueBoardReopenDispatch, { kind: "board_only" }>
    )[];

    expect(branches.map((branch) => branch.kind)).toEqual(
      ISSUE_BOARD_REOPEN_DISPATCH_KINDS,
    );
  });
});
