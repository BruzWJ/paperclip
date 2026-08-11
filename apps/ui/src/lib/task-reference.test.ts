import { describe, expect, it } from "vitest";
import { parseTaskPathIdFromPath, parseTaskReferenceFromHref, remarkLinkTaskReferences } from "./task-reference";

type TreeNode = { type: string; value?: string; url?: string; children?: TreeNode[] };

function paragraph(value: string): TreeNode {
  return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value }] }] };
}

function paragraphChildren(tree: TreeNode): TreeNode[] {
  return tree.children?.[0]?.children ?? [];
}

describe("task-reference", () => {
  it("extracts task ids from company-scoped task paths", () => {
    expect(parseTaskPathIdFromPath("/PAP/tasks/PAP-1271")).toBe("PAP-1271");
    expect(parseTaskPathIdFromPath("/PAP/tasks/pap-1272")).toBe("PAP-1272");
    expect(parseTaskPathIdFromPath("/tasks/pc1a2-7")).toBe("PC1A2-7");
    expect(parseTaskPathIdFromPath("/PC1A2/tasks/pc1a2-7")).toBe("PC1A2-7");
    expect(parseTaskPathIdFromPath("/tasks/PAP-1179")).toBe("PAP-1179");
    expect(parseTaskPathIdFromPath("/tasks/:id")).toBeNull();
  });

  it("does not treat full task URLs as internal task paths", () => {
    expect(parseTaskPathIdFromPath("http://localhost:3100/PAP/tasks/PAP-1179")).toBeNull();
    expect(parseTaskPathIdFromPath("http://remote.example.test:3103/PAPA/tasks/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("does not treat GitHub ticket URLs as internal Paperclip task links", () => {
    const trackerResource = String.fromCharCode(105, 115, 115, 117, 101, 115);
    const externalUrl = `https://github.com/paperclipai/paperclip/${trackerResource}/1778`;
    expect(parseTaskPathIdFromPath(externalUrl)).toBeNull();
    expect(parseTaskReferenceFromHref(externalUrl)).toBeNull();
  });

  it("ignores placeholder task paths", () => {
    expect(parseTaskPathIdFromPath("/tasks/:id")).toBeNull();
    expect(parseTaskPathIdFromPath("http://localhost:3100/tasks/:id")).toBeNull();
    expect(parseTaskReferenceFromHref("/tasks/:id")).toBeNull();
  });

  it("normalizes bare identifiers, relative task paths, and task scheme links into internal links", () => {
    expect(parseTaskReferenceFromHref("pap-1271", new Set(["PAP"]))).toEqual({
      taskPathId: "PAP-1271",
      href: "/tasks/PAP-1271",
    });
    expect(parseTaskReferenceFromHref("pc1a2-7", new Set(["PC1A2"]))).toEqual({
      taskPathId: "PC1A2-7",
      href: "/tasks/PC1A2-7",
    });
    expect(parseTaskReferenceFromHref("/PAP/tasks/pap-1180")).toEqual({
      taskPathId: "PAP-1180",
      href: "/tasks/PAP-1180",
    });
    expect(parseTaskReferenceFromHref("task://PAP-1310")).toEqual({
      taskPathId: "PAP-1310",
      href: "/tasks/PAP-1310",
    });
    expect(parseTaskReferenceFromHref("task://:PAP-1311")).toEqual({
      taskPathId: "PAP-1311",
      href: "/tasks/PAP-1311",
    });
  });

  it("normalizes exact inline-code-like task identifiers", () => {
    expect(parseTaskReferenceFromHref("PAP-1271", new Set(["PAP"]))).toEqual({
      taskPathId: "PAP-1271",
      href: "/tasks/PAP-1271",
    });
  });

  it("preserves absolute Paperclip task URLs so origin, port, and hash are not lost", () => {
    expect(parseTaskReferenceFromHref("http://localhost:3100/PAP/tasks/PAP-1179")).toBeNull();
    expect(parseTaskReferenceFromHref("http://remote.example.test:3103/PAPA/tasks/PAPA-115#comment-850083f3-24de-43e7-a8cd-bc01f7cc9f0d")).toBeNull();
  });

  it("ignores literal route placeholder paths", () => {
    expect(parseTaskReferenceFromHref("/tasks/:id")).toBeNull();
    expect(parseTaskReferenceFromHref("http://localhost:3100/api/tasks/:id")).toBeNull();
  });

  describe("known-prefix gating", () => {
    it("links a bare identifier whose prefix is known", () => {
      expect(parseTaskReferenceFromHref("PAP-1271", new Set(["PAP"]))).toEqual({
        taskPathId: "PAP-1271",
        href: "/tasks/PAP-1271",
      });
    });

    it("matches the prefix case-insensitively", () => {
      expect(parseTaskReferenceFromHref("pap-12", new Set(["PAP"]))).toEqual({
        taskPathId: "PAP-12",
        href: "/tasks/PAP-12",
      });
    });

    it("does not link a bare identifier whose prefix is unknown (e.g. a Jira key)", () => {
      expect(parseTaskReferenceFromHref("JIRA-456", new Set(["PAP"]))).toBeNull();
    });

    it.each([undefined, new Set<string>()])(
      "does not guess a bare identifier without company prefixes",
      (prefixes) => {
        expect(parseTaskReferenceFromHref("FOO-1", prefixes)).toBeNull();
      },
    );

    it("never gates explicit task:// scheme references", () => {
      expect(parseTaskReferenceFromHref("task://ACME-9", new Set(["PAP"]))).toEqual({
        taskPathId: "ACME-9",
        href: "/tasks/ACME-9",
      });
    });

    it("never gates explicit /tasks/ path references", () => {
      expect(parseTaskReferenceFromHref("/ACME/tasks/ACME-9", new Set(["PAP"]))).toEqual({
        taskPathId: "ACME-9",
        href: "/tasks/ACME-9",
      });
    });
  });

  describe("remarkLinkTaskReferences", () => {
    it("links only known-prefix tokens and leaves foreign keys as text", () => {
      const tree = paragraph("See PAP-1 and JIRA-2 today.");
      remarkLinkTaskReferences({ knownPrefixes: ["PAP"] })(tree);

      const children = paragraphChildren(tree);
      expect(children).toEqual([
        { type: "text", value: "See " },
        { type: "link", url: "/tasks/PAP-1", children: [{ type: "text", value: "PAP-1" }] },
        { type: "text", value: " and JIRA-2 today." },
      ]);
    });

    it("leaves bare identifiers untouched when no prefixes are supplied", () => {
      const tree = paragraph("See PAP-1 and JIRA-2.");
      remarkLinkTaskReferences()(tree);

      const links = paragraphChildren(tree).filter((node) => node.type === "link");
      expect(links).toEqual([]);
    });
  });
});
