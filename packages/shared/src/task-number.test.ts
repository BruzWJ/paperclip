import { describe, expect, it } from "vitest";
import {
  MAX_TASK_NUMBER,
  isCanonicalTaskNumber,
  parseTaskNumber,
} from "./task-number.js";

describe("parseTaskNumber", () => {
  it("accepts only exact positive safe decimal integers", () => {
    expect(parseTaskNumber("1")).toBe(1);
    expect(parseTaskNumber("42")).toBe(42);
    expect(parseTaskNumber("2147483647")).toBe(2_147_483_647);
    expect(parseTaskNumber("2147483648")).toBeNull();
    expect(parseTaskNumber("0")).toBeNull();
    expect(parseTaskNumber("01")).toBeNull();
    expect(parseTaskNumber("+1")).toBeNull();
    expect(parseTaskNumber(" 1 ")).toBeNull();
    expect(parseTaskNumber("9007199254740992")).toBeNull();
  });

  it("shares the exact persisted counter range with number consumers", () => {
    expect(MAX_TASK_NUMBER).toBe(2_147_483_647);
    expect(isCanonicalTaskNumber(1)).toBe(true);
    expect(isCanonicalTaskNumber(MAX_TASK_NUMBER)).toBe(true);
    expect(isCanonicalTaskNumber(0)).toBe(false);
    expect(isCanonicalTaskNumber(MAX_TASK_NUMBER + 1)).toBe(false);
    expect(isCanonicalTaskNumber(1.5)).toBe(false);
    expect(isCanonicalTaskNumber("1")).toBe(false);
  });
});
