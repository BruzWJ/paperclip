import { describe, expect, it, vi } from "vitest";
import { canonicalizeExternalObjectUrl } from "@paperclipai/shared/external-objects-server";
import {
  createExternalObjectDetectorRegistry,
  createExternalObjectResolverRegistry,
  externalObjectService,
  type ExternalObjectResolver,
} from "../services/external-objects.js";
import { createGitHubExternalObjectProvider } from "../services/github-external-object-provider.js";
import { createMockDb } from "./helpers/mock-db.js";

describe("external object registries", () => {
  it("lets provider detectors claim URLs before the generic fallback", async () => {
    const github = canonicalizeExternalObjectUrl("https://github.com/acme/app/pull/42");
    const generic = canonicalizeExternalObjectUrl("https://example.com/path?token=secret#fragment");
    if (!github || !generic) throw new Error("expected canonical URLs");
    const registry = createExternalObjectDetectorRegistry([{
      key: "github",
      detect: ({ urls }) => urls
        .filter((url) => url.sanitizedCanonicalUrl.includes("github.com"))
        .map((url) => ({
          canonical: url,
          detectorKey: "github",
          providerKey: "github",
          objectType: "pull_request",
          externalId: "acme/app#42",
          confidence: "exact" as const,
        })),
    }]);

    const detections = await registry.detect({
      companyId: "company-1",
      urls: [github, generic],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "request",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    });

    expect(detections).toEqual([
      expect.objectContaining({ providerKey: "github", objectType: "pull_request" }),
      expect.objectContaining({
        providerKey: "url",
        objectType: "link",
        displayTitle: "https://example.com/path",
      }),
    ]);
    expect(JSON.stringify(detections)).not.toContain("secret");
  });

  it("continues to the next detector when one provider fails", async () => {
    const canonical = canonicalizeExternalObjectUrl("https://example.com/path");
    if (!canonical) throw new Error("expected canonical URL");
    const registry = createExternalObjectDetectorRegistry([{
      key: "broken",
      detect: async () => {
        throw new Error("provider unavailable");
      },
    }]);

    const detections = await registry.detect({
      companyId: "company-1",
      urls: [canonical],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "request",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    });

    expect(detections).toEqual([
      expect.objectContaining({ providerKey: "url", objectType: "link" }),
    ]);
  });

  it("matches resolvers by provider and optional object type", () => {
    const fallbackResolver: ExternalObjectResolver = {
      providerKey: "github",
      resolve: async () => ({
        ok: true,
        snapshot: { statusCategory: "unknown", statusTone: "neutral" },
      }),
    };
    const pullRequestResolver: ExternalObjectResolver = {
      providerKey: "github",
      objectType: "pull_request",
      resolve: async () => ({
        ok: true,
        snapshot: { statusCategory: "open", statusTone: "info" },
      }),
    };
    const registry = createExternalObjectResolverRegistry([pullRequestResolver, fallbackResolver]);

    expect(registry.find({ providerKey: "github", objectType: "pull_request" })).toBe(pullRequestResolver);
    expect(registry.find({ providerKey: "github", objectType: "issue" })).toBe(fallbackResolver);
    expect(registry.find({ providerKey: "linear", objectType: "issue" })).toBeNull();
  });
});

describe("GitHub external object provider", () => {
  function githubObject(path: string, objectType: "pull_request" | "issue") {
    const canonical = canonicalizeExternalObjectUrl(`https://github.com/acme/app/${path}`);
    if (!canonical) throw new Error("expected canonical URL");
    return {
      id: "object-1",
      companyId: "company-1",
      providerKey: "github",
      objectType,
      externalId: `acme/app#${path}`,
      sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
      canonicalIdentityHash: canonical.canonicalIdentityHash,
      displayKey: null,
      iconKey: null,
      displayTitle: "acme/app#42",
      statusKey: null,
      statusLabel: null,
      statusIconKey: null,
      statusCategory: "unknown",
      statusTone: "neutral",
      liveness: "unknown",
      isTerminal: false,
      data: {},
      remoteVersion: null,
      etag: null,
    } as any;
  }

  function response(body: Record<string, unknown>, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"etag-1"', ...(init.headers ?? {}) },
      ...init,
    });
  }

  it("detects GitHub pull request and issue URLs without retaining query secrets", async () => {
    const provider = createGitHubExternalObjectProvider({} as any, { tokenProvider: null });
    const pullRequest = canonicalizeExternalObjectUrl(
      "https://github.com/Acme/App/pull/42?token=secret#discussion",
    );
    const issue = canonicalizeExternalObjectUrl("https://github.com/Acme/App/issues/7");
    if (!pullRequest || !issue) throw new Error("expected canonical URLs");

    const detections = await provider.detector.detect({
      companyId: "company-1",
      urls: [pullRequest, issue],
      sourceContext: {
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "request",
        sourceRecordId: null,
        documentKey: null,
        propertyKey: null,
      },
    });

    expect(detections).toEqual([
      expect.objectContaining({
        providerKey: "github",
        objectType: "pull_request",
        externalId: "acme/app#pull/42",
      }),
      expect.objectContaining({
        providerKey: "github",
        objectType: "issue",
        externalId: "acme/app#issues/7",
      }),
    ]);
    expect(JSON.stringify(detections)).not.toContain("secret");
  });

  it.each([
    [
      "open",
      { state: "open", draft: false, merged: false, title: "Ship it", updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "open", statusCategory: "open", statusTone: "info", isTerminal: false },
    ],
    [
      "draft",
      { state: "open", draft: true, merged: false, title: "WIP", updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "draft", statusCategory: "waiting", statusTone: "warning", isTerminal: false },
    ],
    [
      "merged",
      { state: "closed", draft: false, merged: true, title: "Merged", updated_at: "2026-04-24T01:02:03Z" },
      { statusKey: "merged", statusCategory: "succeeded", statusTone: "success", isTerminal: true },
    ],
  ])("resolves a %s pull request snapshot", async (_name, body, expected) => {
    const fetch = vi.fn(async () => response(body));
    const provider = createGitHubExternalObjectProvider({} as any, { fetch, tokenProvider: null });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "pull_request")!;

    const result = await resolver.resolve({
      companyId: "company-1",
      object: githubObject("pull/42", "pull_request"),
    });

    expect(result).toEqual({
      ok: true,
      snapshot: expect.objectContaining({
        ...expected,
        displayKey: "GitHub Pull Request",
        iconKey: "github",
        remoteVersion: "2026-04-24T01:02:03Z",
        etag: '"etag-1"',
      }),
    });
  });

  it("uses a configured token without storing it in the resolved snapshot", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer ghp_secret" }));
      return response({ state: "open", draft: false, merged: false, title: "Private PR" });
    });
    const provider = createGitHubExternalObjectProvider({} as any, {
      fetch,
      tokenProvider: async () => "ghp_secret",
    });
    const resolver = provider.resolvers.find((entry) => entry.objectType === "pull_request")!;

    const result = await resolver.resolve({
      companyId: "company-1",
      object: githubObject("pull/42", "pull_request"),
    });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
  });
});

describe("externalObjectService", () => {
  it("short-circuits every public read and sync path when external objects are disabled", async () => {
    const mock = createMockDb();
    const service = externalObjectService(mock.db, { enabled: false, github: false });

    await expect(service.syncIssue("issue-1")).resolves.toBeUndefined();
    await expect(service.listForIssue("issue-1")).resolves.toEqual([]);
    await expect(service.getIssueSummary("issue-1")).resolves.toMatchObject({
      total: 0,
    });
    await expect(service.refreshDueObjects("company-1")).resolves.toEqual([]);
    expect(mock.calls).toEqual([]);
  });

  it("syncs only sanitized mention identity into persistence", async () => {
    const objectRow = { id: "object-1" };
    const mock = createMockDb({
      select: [[{
        id: "issue-1",
        companyId: "company-1",
        title: "No external object",
        request: "See https://example.com/path?token=secret#fragment",
      }]],
      delete: [[], []],
      insert: [[objectRow], []],
    });

    await externalObjectService(mock.db, { github: false }).syncIssue("issue-1");

    const mentionValues = mock.calls
      .filter((call) => call.operation === "insert" && call.method === "values")
      .at(-1)?.args[0];
    expect(mentionValues).toEqual([
      expect.objectContaining({
        companyId: "company-1",
        sourceIssueId: "issue-1",
        sourceKind: "request",
        sanitizedDisplayUrl: "https://example.com/path",
        providerKey: "url",
        objectType: "link",
      }),
    ]);
    expect(JSON.stringify(mentionValues)).not.toContain("secret");
    expect(mock.remaining("insert")).toBe(0);
    expect(mock.remaining("delete")).toBe(0);
  });
});
