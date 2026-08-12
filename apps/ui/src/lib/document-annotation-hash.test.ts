import { describe, expect, it } from "vitest";
import {
  buildDocumentAnnotationHash,
  parseDocumentAnnotationHash,
} from "./document-annotation-hash";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const COMMENT_ID = "22222222-2222-4222-8222-222222222222";

describe("parseDocumentAnnotationHash", () => {
  it("returns null for non-document hashes", () => {
    expect(parseDocumentAnnotationHash("")).toBeNull();
    expect(parseDocumentAnnotationHash("#task-foo")).toBeNull();
  });

  it("parses document key only", () => {
    expect(parseDocumentAnnotationHash("#document-plan")).toEqual({
      documentKey: "plan",
      threadId: null,
      commentId: null,
    });
  });

  it("parses thread and comment targets", () => {
    expect(
      parseDocumentAnnotationHash(
        `#document-plan&thread=${THREAD_ID}&comment=${COMMENT_ID}`,
      ),
    ).toEqual({
      documentKey: "plan",
      threadId: THREAD_ID,
      commentId: COMMENT_ID,
    });
  });

  it.each([
    "#document-%70lan",
    "#document-my%20notes",
    `#document-plan&thread=%31${THREAD_ID.slice(1)}`,
    `#document-plan&comment=${COMMENT_ID}`,
    `#document-plan&thread=${THREAD_ID}&thread=${THREAD_ID}`,
    `#document-plan&thread=${THREAD_ID}&comment=not-a-uuid`,
    `#document-plan&comment=${COMMENT_ID}&thread=${THREAD_ID}`,
    "#document-plan&unknown=value",
    "#document-%ZZ",
  ])("rejects the alias or malformed selector %s", (hash) => {
    expect(parseDocumentAnnotationHash(hash)).toBeNull();
  });
});

describe("buildDocumentAnnotationHash", () => {
  it("builds a hash without thread or comment", () => {
    expect(
      buildDocumentAnnotationHash({
        documentKey: "plan",
        threadId: null,
        commentId: null,
      }),
    ).toBe("#document-plan");
  });

  it("includes thread target", () => {
    expect(
      buildDocumentAnnotationHash({
        documentKey: "plan",
        threadId: THREAD_ID,
        commentId: null,
      }),
    ).toBe(`#document-plan&thread=${THREAD_ID}`);
  });

  it("includes both targets", () => {
    expect(
      buildDocumentAnnotationHash({
        documentKey: "plan",
        threadId: THREAD_ID,
        commentId: COMMENT_ID,
      }),
    ).toBe(`#document-plan&thread=${THREAD_ID}&comment=${COMMENT_ID}`);
  });

  it("survives a round trip", () => {
    const target = {
      documentKey: "plan-2",
      threadId: THREAD_ID,
      commentId: COMMENT_ID,
    };
    expect(
      parseDocumentAnnotationHash(buildDocumentAnnotationHash(target)),
    ).toEqual(target);
  });
});
