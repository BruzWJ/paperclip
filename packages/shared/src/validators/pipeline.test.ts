import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  PipelineCaseGenericIssueLinkRole,
  PipelineCaseIssueLinkRole,
} from "../types/pipeline.js";
import {
  pipelineCaseGenericIssueLinkRoleSchema,
  pipelineCaseIssueLinkRoleSchema,
} from "./pipeline.js";

describe("pipeline case issue-link roles", () => {
  it("retains conversation as a stored/output role", () => {
    expect(pipelineCaseIssueLinkRoleSchema.parse("conversation")).toBe(
      "conversation",
    );
    expectTypeOf<Extract<PipelineCaseIssueLinkRole, "conversation">>()
      .toEqualTypeOf<"conversation">();
  });

  it("does not allow generic issue-link creation to promote an issue into a conversation", () => {
    expect(
      pipelineCaseGenericIssueLinkRoleSchema.safeParse("conversation").success,
    ).toBe(false);
    expectTypeOf<Extract<PipelineCaseGenericIssueLinkRole, "conversation">>()
      .toEqualTypeOf<never>();
  });
});
