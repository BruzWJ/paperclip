import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../");
const readSource = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("pipeline conversation canonical cutover", () => {
  it("has exactly one production writer for conversation correlations", () => {
    const routeSource = readSource("apps/server/src/routes/pipelines.ts");
    const serviceSource = readSource("apps/server/src/services/pipelines.ts");

    expect(routeSource.match(/role:\s*"conversation"/g)).toHaveLength(1);
    expect(routeSource).toContain(
      '"/cases/:caseId/open-conversation"',
    );
    expect(routeSource).toContain("pipelineCaseGenericIssueLinkRoleSchema");
    expect(serviceSource).not.toContain('role: "conversation"');
  });

  it("does not retain producer, parent, origin, automation, or work conversation resolution", () => {
    const serviceSource = readSource("apps/server/src/services/pipelines.ts");
    const routeSource = readSource("apps/server/src/routes/pipelines.ts");
    const sharedSource = readSource("packages/shared/src/types/pipeline.ts");

    for (const retiredToken of [
      "resolvePipelineCaseConversationSource",
      "ResolvedPipelineCaseConversationSource",
      "PipelineCaseConversationSource",
      "producer_update",
      "producer_create",
      "inherited_parent_producer",
      "own_producer",
      "conversationSource",
    ]) {
      expect(
        serviceSource + routeSource + sharedSource,
        retiredToken,
      ).not.toContain(retiredToken);
    }
  });

  it("keeps case-body documents board-side without an issue-document annotation mirror", () => {
    const routeSource = readSource("apps/server/src/routes/pipelines.ts");
    const serviceSource = readSource("apps/server/src/services/pipelines.ts");
    const componentSource = readSource(
      "apps/ui/src/components/PipelineItemBodyDocument.tsx",
    );

    expect(routeSource + serviceSource + componentSource).not.toContain(
      "PIPELINE_CASE_BODY_DOCUMENT_KEY",
    );
    expect(routeSource).not.toContain("issueDocuments");
    expect(serviceSource).not.toContain("issueDocuments");
    expect(componentSource).not.toContain("IssueDocumentAnnotations");
    expect(componentSource).not.toContain("DocumentAnnotationLayer");
    expect(
      existsSync(
        path.join(
          repoRoot,
          "apps/server/src/services/pipeline-conversation-context.ts",
        ),
      ),
    ).toBe(false);
  });
});
