import { describe, expect, it } from "vitest";
import {
  TASK_BOARD_REOPEN_DISPATCH_KINDS,
  TASK_EXECUTION_REF_SOURCE_KINDS,
  PAPERCLIP_ACTION_KEYS,
  PAPERCLIP_RUNTIME_ACTION_KEYS,
  type TaskBoardReopenDispatch,
} from "./task-runtime.js";

describe("task execution source taxonomy", () => {
  it("contains only durable execution causes, not recovery implementations", () => {
    expect(TASK_EXECUTION_REF_SOURCE_KINDS).toEqual([
      "task_request",
      "task_reassignment",
      "task_reopen",
      "human_comment_mention",
      "routine_dispatch",
      "task_update",
      "consult_mention",
      "system_nudge",
    ]);
  });
});

describe("canonical board reopen dispatch contract", () => {
  it("contains only the exact provider and provider-free branches", () => {
    expect(TASK_BOARD_REOPEN_DISPATCH_KINDS).toEqual([
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
          Extract<TaskBoardReopenDispatch, { kind: "agent_execution" }>,
          "kind"
        > & { executionRef: { id: string } }
      | Extract<TaskBoardReopenDispatch, { kind: "board_only" }>
    )[];

    expect(branches.map((branch) => branch.kind)).toEqual(
      TASK_BOARD_REOPEN_DISPATCH_KINDS,
    );
  });
});

describe("Paperclip task-action authority vocabulary", () => {
  it("keeps configurable grants separate from relationship-derived runtime actions", () => {
    expect(PAPERCLIP_ACTION_KEYS).toEqual([
      "task_create",
      "mention_board",
      "agent_hire",
      "agent_configure",
      "list_all_agents",
      "list_parent_agents",
    ]);
    expect(PAPERCLIP_RUNTIME_ACTION_KEYS).toEqual([
      "task_create",
      "task_assign",
      "task_update",
      "mention_agent",
      "mention_board",
      "agent_hire",
      "agent_configure",
      "list_agents",
      "agent_read",
    ]);
  });
});
