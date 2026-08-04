import { describe, expect, it } from "vitest";
import { companyArtifactsService } from "../services/company-artifacts.js";
import { createMockDb } from "./helpers/mock-db.js";

const issueId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "document:document-1",
    documentId: "document-1",
    issueId,
    issueIdentifier: "PAP-12",
    issueTitle: "Ship the release",
    projectId,
    projectName: "Paperclip",
    key: "release-notes",
    title: "Release notes",
    latestBody: "# Release\n\nThe **canonical** notes are ready.",
    createdByAgentId: agentId,
    createdByAgentName: "Writer",
    updatedAt: new Date("2026-04-03T12:00:00.000Z"),
    ...overrides,
  };
}

describe("companyArtifactsService", () => {
  it("projects agent-created issue documents into the canonical artifact shape", async () => {
    const mock = createMockDb({
      select: [
        [{ id: "company-1", issuePrefix: "PAP" }],
        [documentRow()],
      ],
    });

    const result = await companyArtifactsService(mock.db).list("company-1", {
      kind: "document",
      limit: 30,
    });

    expect(result).toEqual({
      artifacts: [{
        id: "document:document-1",
        source: "document",
        mediaKind: "document",
        title: "Release notes",
        previewText: "Release The canonical notes are ready.",
        contentType: "text/markdown",
        contentPath: null,
        openPath: null,
        downloadPath: null,
        issue: { id: issueId, identifier: "PAP-12", title: "Ship the release" },
        project: { id: projectId, name: "Paperclip" },
        createdByAgent: { id: agentId, name: "Writer" },
        updatedAt: "2026-04-03T12:00:00.000Z",
        href: "/PAP/issues/PAP-12#document-release-notes",
      }],
      nextCursor: null,
    });
    expect(mock.remaining("select")).toBe(0);
  });

  it("sorts before pagination and emits an opaque continuation cursor", async () => {
    const newer = documentRow({
      artifactId: "document:newer",
      documentId: "newer",
      updatedAt: new Date("2026-04-04T12:00:00.000Z"),
    });
    const older = documentRow({
      artifactId: "document:older",
      documentId: "older",
      updatedAt: new Date("2026-04-02T12:00:00.000Z"),
    });
    const mock = createMockDb({
      select: [
        [{ id: "company-1", issuePrefix: "PAP" }],
        [older, newer],
      ],
    });

    const firstPage = await companyArtifactsService(mock.db).list("company-1", {
      kind: "document",
      limit: 1,
    });

    expect(firstPage.artifacts.map((artifact) => artifact.id)).toEqual(["document:newer"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const cursorPayload = JSON.parse(
      Buffer.from(firstPage.nextCursor!, "base64url").toString("utf8"),
    );
    expect(cursorPayload).toEqual({
      id: "document:newer",
      updatedAt: "2026-04-04T12:00:00.000Z",
    });
  });

  it("builds issue groups after projection and keeps a bounded preview", async () => {
    const rows = [
      documentRow({ artifactId: "document:3", documentId: "3" }),
      documentRow({ artifactId: "document:2", documentId: "2" }),
      documentRow({ artifactId: "document:1", documentId: "1" }),
      documentRow({ artifactId: "document:0", documentId: "0" }),
    ];
    const mock = createMockDb({
      select: [
        [{ id: "company-1", issuePrefix: "PAP" }],
        rows,
        [{
          id: issueId,
          parentId: null,
          identifier: "PAP-12",
          title: "Ship the release",
          updatedAt: new Date("2026-04-03T12:00:00.000Z"),
        }],
      ],
    });

    const result = await companyArtifactsService(mock.db).list("company-1", {
      kind: "document",
      groupBy: "issue",
      limit: 10,
    });

    expect(result.artifacts).toEqual([]);
    expect(result.groups).toEqual([
      expect.objectContaining({
        id: `issue:${issueId}`,
        groupBy: "issue",
        issue: { id: issueId, identifier: "PAP-12", title: "Ship the release" },
        count: 4,
        mediaKinds: ["document"],
        previewArtifacts: expect.any(Array),
      }),
    ]);
    expect(result.groups?.[0]?.previewArtifacts).toHaveLength(3);
  });

  it("rejects invalid cursors before touching persistence", async () => {
    const mock = createMockDb();

    await expect(companyArtifactsService(mock.db).list("company-1", {
      kind: "document",
      cursor: "not-a-cursor",
    })).rejects.toMatchObject({ status: 400 });
    expect(mock.calls).toEqual([]);
  });

  it("fails closed when the company does not exist", async () => {
    const mock = createMockDb({ select: [[]] });

    await expect(companyArtifactsService(mock.db).list("missing-company", {
      kind: "document",
    })).rejects.toMatchObject({ status: 404 });
    expect(mock.remaining("select")).toBe(0);
  });
});
