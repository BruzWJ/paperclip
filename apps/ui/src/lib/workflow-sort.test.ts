import { describe, expect, it } from "vitest";
import { workflowSort, type WorkflowSortTask } from "./workflow-sort";

type TestTask = WorkflowSortTask & { label?: string };

function task(
  id: string,
  createdAt: string,
  blockedByIds: string[] = [],
  label?: string,
): TestTask {
  return {
    id,
    createdAt,
    blockedBy: blockedByIds.map((blockerId) => ({ id: blockerId })),
    label,
  };
}

function orderedIds(tasks: TestTask[]): string[] {
  return tasks.map((entry) => entry.id);
}

describe("workflowSort", () => {
  it("returns a stable creation-order list when there are no blockers (roots only)", () => {
    const out = workflowSort([
      task("b", "2026-04-02T00:00:00.000Z"),
      task("a", "2026-04-01T00:00:00.000Z"),
      task("c", "2026-04-03T00:00:00.000Z"),
    ]);
    expect(orderedIds(out)).toEqual(["a", "b", "c"]);
  });

  it("keeps a short two-node chain contiguous right after its predecessor", () => {
    const out = workflowSort([
      task("z", "2026-04-05T00:00:00.000Z"),
      task("chain-end", "2026-04-03T00:00:00.000Z", ["chain-start"]),
      task("chain-start", "2026-04-02T00:00:00.000Z"),
    ]);
    expect(orderedIds(out)).toEqual(["chain-start", "chain-end", "z"]);
  });

  it("walks long linear chains all the way to the end (PAP-1953 shape)", () => {
    // Chain shape taken from the plan on PAP-2189:
    //   roots standalone: 1954, 1955
    //   short chain: 1960 -> 1961
    //   long chain: 1962 -> 1963 -> 1964 -> 1965 -> 1966
    const created = (days: number) =>
      new Date(Date.UTC(2026, 3, days)).toISOString();
    const input: TestTask[] = [
      task("1964", created(7), ["1963"]),
      task("1966", created(9), ["1965"]),
      task("1955", created(2)),
      task("1960", created(3)),
      task("1961", created(4), ["1960"]),
      task("1963", created(6), ["1962"]),
      task("1954", created(1)),
      task("1965", created(8), ["1964"]),
      task("1962", created(5)),
    ];
    const out = workflowSort(input);
    expect(orderedIds(out)).toEqual([
      "1954",
      "1955",
      "1960",
      "1961",
      "1962",
      "1963",
      "1964",
      "1965",
      "1966",
    ]);
  });

  it("stops chain walking at a branch and returns to the ready queue in tie-break order", () => {
    // root -> child-a, root -> child-b. Root has two successors, so walk stops
    // after root and we fall back to ready-queue ordering (createdAt asc).
    const out = workflowSort([
      task("later-standalone", "2026-04-10T00:00:00.000Z"),
      task("child-b", "2026-04-03T00:00:00.000Z", ["root"]),
      task("child-a", "2026-04-02T00:00:00.000Z", ["root"]),
      task("root", "2026-04-01T00:00:00.000Z"),
    ]);
    expect(orderedIds(out)).toEqual(["root", "child-a", "child-b", "later-standalone"]);
  });

  it("stops chain walking at a merge (successor has multiple predecessors)", () => {
    // a and b both block c. After emitting a, c still has pending predecessor
    // b, so the chain walk breaks. c emits once both predecessors are done.
    const out = workflowSort([
      task("c", "2026-04-03T00:00:00.000Z", ["a", "b"]),
      task("a", "2026-04-01T00:00:00.000Z"),
      task("b", "2026-04-02T00:00:00.000Z"),
    ]);
    expect(orderedIds(out)).toEqual(["a", "b", "c"]);
  });

  it("treats blockers outside the visible set as absent for ordering", () => {
    // beta's blocker 'alpha' is not in the visible list, so beta is treated as
    // a root and sorts purely by createdAt against the other root.
    const out = workflowSort([
      task("beta", "2026-04-01T00:00:00.000Z", ["alpha"]),
      task("gamma", "2026-04-02T00:00:00.000Z"),
    ]);
    expect(orderedIds(out)).toEqual(["beta", "gamma"]);
  });

  it("breaks ties by id when createdAt collides", () => {
    const same = "2026-04-01T00:00:00.000Z";
    const out = workflowSort([
      task("z", same),
      task("a", same),
      task("m", same),
    ]);
    expect(orderedIds(out)).toEqual(["a", "m", "z"]);
  });

  it("falls back to tie-break order when the input contains a cycle", () => {
    // a blocks b, b blocks a. Neither has in-degree 0, so nothing would emit
    // via the greedy walk — the guard must fall back to a deterministic order.
    const out = workflowSort([
      task("b", "2026-04-02T00:00:00.000Z", ["a"]),
      task("a", "2026-04-01T00:00:00.000Z", ["b"]),
    ]);
    expect(orderedIds(out)).toEqual(["a", "b"]);
  });

  it("guards against malformed self-loops without hanging", () => {
    const out = workflowSort([
      task("self", "2026-04-01T00:00:00.000Z", ["self"]),
      task("next", "2026-04-02T00:00:00.000Z"),
    ]);
    expect(orderedIds(out)).toEqual(["self", "next"]);
  });

  it("returns a new array without mutating the input", () => {
    const input = [
      task("b", "2026-04-02T00:00:00.000Z"),
      task("a", "2026-04-01T00:00:00.000Z"),
    ];
    const snapshot = orderedIds(input);
    const out = workflowSort(input);
    expect(out).not.toBe(input);
    expect(orderedIds(input)).toEqual(snapshot);
    expect(orderedIds(out)).toEqual(["a", "b"]);
  });

  it("handles empty or single-item inputs", () => {
    expect(workflowSort([])).toEqual([]);
    const single = [task("only", "2026-04-01T00:00:00.000Z")];
    expect(workflowSort(single)).toEqual(single);
  });
});
