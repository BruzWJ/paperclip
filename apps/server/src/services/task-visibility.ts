import { isNull, type SQL } from "drizzle-orm";
import { tasks } from "@paperclipai/db";

export function visibleTaskCondition(): SQL {
  return isNull(tasks.hiddenAt);
}
