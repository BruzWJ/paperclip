import { describe, expect, it } from "vitest";
import { parseTaskReferenceFromHref, remarkLinkTaskReferences } from "./task-reference";

const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("UUID task references", () => {
  it("parses only the canonical task scheme with a UUID payload", () => {
    expect(parseTaskReferenceFromHref(`task://${TASK_ID}`)).toEqual({
      taskId: TASK_ID,
      href: `task://${TASK_ID}`,
    });
    expect(parseTaskReferenceFromHref("task://PAP-1271")).toBeNull();
    expect(parseTaskReferenceFromHref("PAP-1271")).toBeNull();
    expect(
      parseTaskReferenceFromHref(
        "/11111111-1111-4111-8111-111111111111/tasks/PAP-1271",
      ),
    ).toBeNull();
    expect(parseTaskReferenceFromHref(`https://example.test/tasks/${TASK_ID}`)).toBeNull();
  });

  it("linkifies explicit UUID task references without linking display identifiers", () => {
    const tree = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: `See task://${TASK_ID} and PAP-1271.` }] }],
    };

    remarkLinkTaskReferences()(tree);

    expect(tree.children[0]?.children).toEqual([
      { type: "text", value: "See " },
      {
        type: "link",
        url: `task://${TASK_ID}`,
        children: [{ type: "text", value: `task://${TASK_ID}` }],
      },
      { type: "text", value: " and PAP-1271." },
    ]);
  });
});
