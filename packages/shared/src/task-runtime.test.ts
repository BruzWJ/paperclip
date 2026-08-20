import { describe, expect, it } from "vitest";
import {
  TASK_EXECUTION_REF_SOURCE_KINDS,
  PAPERCLIP_ACTION_KEYS,
  PAPERCLIP_RUNTIME_ACTION_KEYS,
  taskLifecycleStatusTargets,
} from "./task-runtime.js";

describe("task execution source taxonomy", () => {
  it("contains only durable execution causes, not recovery implementations", () => {
    expect(TASK_EXECUTION_REF_SOURCE_KINDS).toEqual([
      "task_request",
      "task_reassignment",
      "mention_agent",
      "routine_dispatch",
      "task_update",
      "system_nudge",
    ]);
  });
});

describe("task lifecycle transitions", () => {
  it("defines one legal target map", () => {
    expect(taskLifecycleStatusTargets("open")).toEqual(["blocked", "done", "cancelled"]);
    expect(taskLifecycleStatusTargets("blocked")).toEqual(["open", "done", "cancelled"]);
    expect(taskLifecycleStatusTargets("done")).toEqual(["open"]);
    expect(taskLifecycleStatusTargets("cancelled")).toEqual(["open"]);
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
