import { and, isNull, type SQL } from "drizzle-orm";
import { tasks } from "@paperclipai/db";

export function visibleTaskCondition(): SQL {
  return and(isNull(tasks.hiddenAt), isNull(tasks.harnessKind))!;
}

export function visibleTaskSql(alias = "tasks") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL`;
}
