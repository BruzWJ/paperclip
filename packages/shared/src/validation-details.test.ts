import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addValidationDetail, validationDetails } from "./validation-details.js";

describe("validation detail bridge", () => {
  it("preserves custom detail shape and the original detail array", () => {
    const schema = z.object({ name: z.string() }).superRefine((_, context) => {
      addValidationDetail(context, {
        message: "Name is unavailable",
        path: ["name"],
        params: { reason: "reserved" },
      });
    });

    const result = schema.safeParse({ name: "taken" });
    expect(result.success).toBe(false);
    if (result.success) return;

    const details = validationDetails(result.error);
    expect(details).toBe(validationDetails(result.error));
    expect(details).toEqual([
      {
        code: "custom",
        message: "Name is unavailable",
        path: ["name"],
        params: { reason: "reserved" },
      },
    ]);
  });
});
