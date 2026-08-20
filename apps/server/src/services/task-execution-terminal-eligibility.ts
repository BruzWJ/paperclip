import { taskExecutionRefs } from "@paperclipai/db";
import type {
  AgentVisibleTaskStatus,
  TaskExecutionRefMessageKind,
  TaskExecutionRefMode,
  TaskExecutionRefSourceKind,
} from "@paperclipai/shared";
import { and, eq, inArray, or } from "drizzle-orm";

type TerminalExecutionRef = {
  sourceKind: TaskExecutionRefSourceKind;
  messageKind: TaskExecutionRefMessageKind;
  mode: TaskExecutionRefMode;
};

export function terminalExecutionRefSql() {
  return and(
    eq(taskExecutionRefs.mode, "owner"),
    or(
      and(
        inArray(taskExecutionRefs.sourceKind, ["mention_agent", "task_update"]),
        eq(taskExecutionRefs.messageKind, "user"),
      ),
      and(
        eq(taskExecutionRefs.sourceKind, "task_request"),
        eq(taskExecutionRefs.messageKind, "synthetic"),
      ),
    ),
  );
}

export function terminalExecutionRef(input: TerminalExecutionRef): boolean {
  return (
    input.mode === "owner" &&
    ((input.messageKind === "user" &&
      (input.sourceKind === "mention_agent" || input.sourceKind === "task_update")) ||
      (input.messageKind === "synthetic" && input.sourceKind === "task_request"))
  );
}

export function lifecycleAcceptsExecution(input: {
  lifecycleStatus: AgentVisibleTaskStatus | null;
  terminalEligible: boolean;
}): boolean {
  return (
    input.lifecycleStatus === "open" ||
    input.lifecycleStatus === "blocked" ||
    (input.terminalEligible &&
      (input.lifecycleStatus === "done" || input.lifecycleStatus === "cancelled"))
  );
}
