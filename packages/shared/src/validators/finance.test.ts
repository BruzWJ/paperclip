import { describe, expect, it } from "vitest";
import { createFinanceEventSchema } from "./finance.js";

const baseEvent = {
  eventKind: "manual_adjustment" as const,
  biller: "provider",
  amount: "1",
  currency: "USD",
  occurredAt: "2026-08-12T00:00:00.000Z",
};

describe("createFinanceEventSchema", () => {
  it("accepts an exact ACPX registry agent name", () => {
    expect(
      createFinanceEventSchema.parse({
        ...baseEvent,
        executionAdapterType: "claude-code",
      }).executionAdapterType,
    ).toBe("claude-code");
  });

  it.each(["", " acpx", "acpx ", " acpx "])(
    "rejects a non-exact execution adapter identity %j",
    (executionAdapterType) => {
      expect(
        createFinanceEventSchema.safeParse({
          ...baseEvent,
          executionAdapterType,
        }).success,
      ).toBe(false);
    },
  );
});
