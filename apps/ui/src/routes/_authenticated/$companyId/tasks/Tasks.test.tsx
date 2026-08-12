import { describe, expect, it } from "vitest";
import type { Task } from "@paperclipai/shared";
import { getNextTasksPageOffset, mergeTaskPagesStable } from ".";

function createTask(id: string, title: string): Task {
  return { id, title } as Task;
}

describe("tasks page pagination helpers", () => {
  it("advances to the next offset when the current page is full", () => {
    expect(getNextTasksPageOffset(100, 0)).toBe(100);
    expect(getNextTasksPageOffset(100, 100)).toBe(200);
    expect(getNextTasksPageOffset(1000, 2000, 1000)).toBe(3000);
  });

  it("stops requesting task pages when the current page is partial", () => {
    expect(getNextTasksPageOffset(99, 0)).toBeUndefined();
    expect(getNextTasksPageOffset(999, 2000, 1000)).toBeUndefined();
  });

  it("dedupes overlapping pages without moving the original task position", () => {
    const first = createTask("task-1", "Original first");
    const second = createTask("task-2", "Second");
    const duplicateFirst = createTask("task-1", "Duplicate first");
    const third = createTask("task-3", "Third");

    expect(
      mergeTaskPagesStable([
        [first, second],
        [duplicateFirst, third],
      ]),
    ).toEqual([first, second, third]);
  });
});
