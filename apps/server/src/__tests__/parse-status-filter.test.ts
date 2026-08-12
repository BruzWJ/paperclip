import { describe, expect, it } from "vitest";
import { parseStatusFilter } from "../services/tasks.ts";

describe("parseStatusFilter", () => {
  it("maps an absent status to no filter", () => {
    expect(parseStatusFilter(undefined)).toEqual([]);
  });

  it("accepts one status or repeated status keys", () => {
    expect(parseStatusFilter("todo")).toEqual(["todo"]);
    expect(parseStatusFilter(["todo", "in_progress"])).toEqual([
      "todo",
      "in_progress",
    ]);
  });

  it.each([
    "",
    "todo,in_progress",
    " todo ",
    "unknown",
    ["todo", "todo"],
    ["todo", 42],
    { status: "todo" },
  ])("rejects a non-canonical status representation: %j", (input) => {
    expect(() => parseStatusFilter(input)).toThrow(
      "status must contain unique canonical task status values",
    );
  });

  it("does not mutate caller-supplied arrays", () => {
    const input: readonly string[] = ["todo", "in_progress"];
    const out = parseStatusFilter(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(["todo", "in_progress"]);
  });

});
