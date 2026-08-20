import { describe, expect, it } from "vitest";
import { createTestTask } from "../test-utils/task";
import { withOptimisticTaskTitle, withOptimisticTaskTitleInCollection } from "./optimistic-task-comments";

describe("optimistic task title", () => {
  it("updates the detail and only the matching collection item", () => {
    const task = createTestTask({ id: "task-1", title: "Before" });
    const other = createTestTask({ id: "task-2", title: "Other" });

    expect(withOptimisticTaskTitle(task, "After")?.title).toBe("After");
    const collection = withOptimisticTaskTitleInCollection([task, other], task.id, "After");
    expect(collection?.[0]?.title).toBe("After");
    expect(collection?.[1]).toBe(other);
  });
});
