// @vitest-environment node

import { describe, expect, it } from "vitest";

import { resolveTaskDetailResourceReveal } from "./-task-detail-model";

const ID = "11111111-1111-4111-8111-111111111111";

describe("resolveTaskDetailResourceReveal", () => {
  it("routes attachment and output fragments to the Resources inspector tab", () => {
    expect(resolveTaskDetailResourceReveal(`attachment-${ID}`)).toEqual({
      kind: "artifact",
      target: { kind: "attachment", id: ID },
    });
    expect(resolveTaskDetailResourceReveal(`#work-product-${ID}`)).toEqual({
      kind: "artifact",
      target: { kind: "work-product", id: ID },
    });
  });

  it("routes document and annotation fragments to the document workspace", () => {
    expect(resolveTaskDetailResourceReveal("document-plan")).toEqual({
      kind: "document",
      documentKey: "plan",
    });
    expect(resolveTaskDetailResourceReveal(`#document-plan&thread=${ID}`)).toEqual({
      kind: "document",
      documentKey: "plan",
    });
  });

  it("ignores unrelated and malformed fragments", () => {
    expect(resolveTaskDetailResourceReveal("comment-1")).toBeNull();
    expect(resolveTaskDetailResourceReveal("attachment-not-a-uuid")).toBeNull();
  });
});
