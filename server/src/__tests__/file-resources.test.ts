import express from "express";
import type { Request } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { WorkspaceFileContent, WorkspaceFileListResponse } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import {
  createFileResourceLimiter,
  createFileResourceListLimiter,
  fileResourceRoutes,
  type WorkspaceFileResourceService,
} from "../routes/file-resources.js";
import { workspaceFileResourceService } from "../services/workspace-file-resources.js";
import { createMockDb } from "./helpers/mock-db.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const activity = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock("../services/activity-log.js", async () => ({
  ...await vi.importActual<typeof import("../services/activity-log.js")>(
    "../services/activity-log.js",
  ),
  logActivity: activity.log,
}));

const companyId = "00000000-0000-4000-8000-000000000001";
const otherCompanyId = "00000000-0000-4000-8000-000000000002";
const issueId = "00000000-0000-4000-8000-000000000003";
const projectId = "00000000-0000-4000-8000-000000000004";
const workspaceId = "00000000-0000-4000-8000-000000000005";
const roots: string[] = [];

const issue = {
  id: issueId,
  companyId,
  projectId,
  projectWorkspaceId: workspaceId,
  parentId: null,
  ownershipEpoch: 1,
} as never;

async function workspaceFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-resources-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# Paperclip\n", "utf8");
  await fs.writeFile(path.join(root, "src", "app.ts"), "export const ok = true;\n", "utf8");
  await fs.writeFile(path.join(root, ".env"), "SECRET=hidden\n", "utf8");
  return root;
}

function project(root: string, overrides: Record<string, unknown> = {}) {
  return {
    id: projectId,
    companyId,
    name: "Paperclip",
    ...overrides,
  };
}

function projectWorkspace(root: string, overrides: Record<string, unknown> = {}) {
  return {
    id: workspaceId,
    companyId,
    projectId,
    name: "Primary workspace",
    sourceType: "local_path",
    cwd: root,
    isPrimary: true,
    ...overrides,
  };
}

function serviceHarness(root: string, overrides?: {
  project?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
}) {
  const harness = createMockDb({
    select: [[project(root, overrides?.project)], [projectWorkspace(root, overrides?.workspace)]],
  });
  return { harness, service: workspaceFileResourceService(harness.db) };
}

function target(pathname: string) {
  return {
    path: pathname,
    workspace: "project" as const,
    projectId,
    workspaceId,
  };
}

function boardActor(ids = [companyId]) {
  return testBoardSessionActor({
    userId: "board-user",
    companyIds: ids,
    memberships: ids.map((id) => ({
      companyId: id,
      membershipRole: "operator" as const,
      status: "active" as const,
    })),
  });
}

function createApp(
  db: Db,
  actor: Request["actor"],
  routeOpts: Parameters<typeof fileResourceRoutes>[1],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", fileResourceRoutes(db, routeOpts));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  activity.log.mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("workspace file resource service", () => {
  it("reads an explicitly selected local project file without exposing its host path", async () => {
    const root = await workspaceFixture();
    const { harness, service } = serviceHarness(root);

    const result = await service.readContent(issueId, target("README.md"), { issue });

    expect(result).toMatchObject({
      resource: {
        kind: "file",
        title: "README.md",
        displayPath: "Paperclip / README.md",
        workspaceKind: "project_workspace",
        workspaceId,
        projectId,
        previewKind: "text",
      },
      content: { encoding: "utf8", data: "# Paperclip\n" },
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(harness.remaining("select")).toBe(0);
  });

  it("lists safe children and recursively filters by search query", async () => {
    const root = await workspaceFixture();
    const direct = serviceHarness(root);
    const listed = await direct.service.list(issueId, {
      ...target("ignored"),
      path: null,
      limit: 10,
    }, { issue });
    expect(listed.state).toBe("available");
    expect(listed.items.map((item) => item.relativePath)).toEqual(["src", "README.md"]);
    expect(listed.items.some((item) => item.relativePath === ".env")).toBe(false);

    const searchedHarness = serviceHarness(root);
    const searched = await searchedHarness.service.list(issueId, {
      workspace: "project",
      projectId,
      workspaceId,
      q: "app.ts",
      limit: 1,
    }, { issue });
    expect(searched.items.map((item) => item.relativePath)).toEqual(["src/app.ts"]);
    expect(direct.harness.remaining("select")).toBe(0);
    expect(searchedHarness.harness.remaining("select")).toBe(0);
  });

  it.each(["../outside.txt", "/etc/passwd"])(
    "rejects lexically unsafe path %s before resolving a workspace",
    async (unsafePath) => {
      const harness = createMockDb();
      const service = workspaceFileResourceService(harness.db);
      await expect(service.readContent(issueId, target(unsafePath), { issue })).rejects.toMatchObject({
        status: expect.any(Number),
      });
      expect(harness.calls).toEqual([]);
    },
  );

  it.each([".env", ".ssh/id_rsa"])(
    "rejects secret path %s after resolving only the authorized workspace boundary",
    async (unsafePath) => {
      const root = await workspaceFixture();
      const { harness, service } = serviceHarness(root);
      await expect(service.readContent(issueId, target(unsafePath), { issue })).rejects.toMatchObject({
        status: 403,
        details: { code: "denied_secret" },
      });
      expect(harness.remaining("select")).toBe(0);
    },
  );

  it("rejects a symlink that resolves outside the selected workspace", async () => {
    const root = await workspaceFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-file-outside-"));
    roots.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    const { service } = serviceHarness(root);

    await expect(service.readContent(issueId, target("link.txt"), { issue })).rejects.toMatchObject({
      status: 403,
      details: { code: "outside_workspace" },
    });
  });

  it("fails closed for cross-company and mismatched project workspace targets", async () => {
    const root = await workspaceFixture();
    const crossCompany = serviceHarness(root, {
      workspace: { companyId: otherCompanyId },
    });
    await expect(crossCompany.service.resolve(issueId, target("README.md"), { issue })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_company_workspace" },
    });

    const mismatched = serviceHarness(root, {
      workspace: { projectId: "00000000-0000-4000-8000-000000000099" },
    });
    await expect(mismatched.service.resolve(issueId, target("README.md"), { issue })).rejects.toMatchObject({
      status: 422,
      details: { code: "workspace_project_mismatch" },
    });
  });

  it("reports explicit remote workspaces as unavailable without touching the host filesystem", async () => {
    const root = await workspaceFixture();
    const { service } = serviceHarness(root, {
      workspace: { sourceType: "remote_managed", cwd: null },
    });

    await expect(service.readContent(issueId, target("README.md"), { issue })).rejects.toMatchObject({
      status: 422,
      details: { code: "remote_workspace" },
    });
  });
});

function contentFixture(): WorkspaceFileContent {
  return {
    resource: {
      kind: "file",
      provider: "local_fs",
      title: "README.md",
      displayPath: "Paperclip / README.md",
      workspaceLabel: "Primary workspace",
      workspaceKind: "project_workspace",
      workspaceId,
      projectId,
      projectName: "Paperclip",
      contentType: "text/plain; charset=utf-8",
      byteSize: 12,
      previewKind: "text",
      denialReason: null,
      capabilities: { preview: true, download: true, listChildren: false },
    },
    content: { encoding: "utf8", data: "# Paperclip\n" },
  };
}

function listFixture(): WorkspaceFileListResponse {
  return {
    kind: "workspace_file_list",
    state: "available",
    workspace: {
      provider: "local_fs",
      workspaceLabel: "Primary workspace",
      workspaceKind: "project_workspace",
      workspaceId,
      projectId,
      projectName: "Paperclip",
    },
    query: { workspace: "project", mode: "all", path: null, q: null, limit: 25, offset: 0 },
    items: [],
    scannedCount: 0,
    truncated: false,
  };
}

function routeService(overrides: Partial<WorkspaceFileResourceService> = {}): WorkspaceFileResourceService {
  return {
    getIssue: vi.fn(async () => ({ companyId })),
    list: vi.fn(async () => listFixture()),
    resolve: vi.fn(async () => contentFixture().resource),
    readContent: vi.fn(async () => contentFixture()),
    prepareDownload: vi.fn(async () => {
      throw new Error("download not configured");
    }),
    ...overrides,
  };
}

describe("workspace file resource routes", () => {
  it("serves board previews and records a redacted success audit", async () => {
    const harness = createMockDb();
    const service = routeService();
    const app = createApp(harness.db, boardActor(), { service });

    const response = await request(app)
      .get(`/api/issues/${issueId}/file-resources/content`)
      .query({ path: "README.md", workspace: "project", projectId, workspaceId });

    expect(response.status).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body.content.data).toBe("# Paperclip\n");
    expect(activity.log).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      action: "issue.file_resource_content_read",
      actorId: "board-user",
      details: expect.objectContaining({
        outcome: "success",
        displayPath: "Paperclip / README.md",
      }),
    }));
    expect(harness.calls).toEqual([]);
  });

  it("returns the same not-found response for a cross-company board probe and audits denial", async () => {
    const harness = createMockDb();
    const service = routeService({
      getIssue: vi.fn(async () => ({ companyId: otherCompanyId })),
    });
    const app = createApp(harness.db, boardActor(), { service });

    const response = await request(app)
      .get(`/api/issues/${issueId}/file-resources/content`)
      .query({ path: "README.md" });

    expect(response.status).toBe(404);
    expect(service.readContent).not.toHaveBeenCalled();
    expect(activity.log).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      action: "issue.file_resource_content_denied",
      details: expect.objectContaining({ outcome: "denied", denialReason: "Issue not found" }),
    }));
  });

  it("rejects malformed targets before invoking the resource operation and audits only safe fields", async () => {
    const harness = createMockDb();
    const service = routeService();
    const app = createApp(harness.db, boardActor(), { service });

    const response = await request(app)
      .get(`/api/issues/${issueId}/file-resources/content`)
      .query({ path: "bad\npath", projectId });

    expect(response.status).toBe(422);
    expect(service.readContent).not.toHaveBeenCalled();
    expect(activity.log).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      action: "issue.file_resource_content_denied",
      details: expect.objectContaining({ outcome: "denied", projectId }),
    }));
    const audit = activity.log.mock.calls.at(-1)?.[1];
    expect(JSON.stringify(audit)).not.toContain("bad\\npath");
  });

  it("serves deterministic list responses through an injected service", async () => {
    const harness = createMockDb();
    const service = routeService();
    const app = createApp(harness.db, boardActor(), { service });

    const response = await request(app)
      .get(`/api/issues/${issueId}/file-resources/list`)
      .query({ workspace: "project", projectId, workspaceId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ kind: "workspace_file_list", state: "available" });
    expect(activity.log).toHaveBeenCalledWith(harness.db, expect.objectContaining({
      action: "issue.file_resource_list",
      details: expect.objectContaining({ resultCount: 0, scannedCount: 0 }),
    }));
  });
});

describe("file resource limiters", () => {
  it("enforces concurrent and request-window bounds without external state", () => {
    const limiter = createFileResourceLimiter({ maxConcurrent: 1, maxRequests: 2, windowMs: 60_000 });
    const release = limiter.acquire("company:user:issue");
    expect(() => limiter.acquire("company:user:issue")).toThrow("Too many concurrent");
    release();
    expect(() => limiter.acquire("company:user:issue")).toThrow("Too many file preview requests");
  });

  it("uses tighter canonical defaults for list operations", () => {
    const limiter = createFileResourceListLimiter({ maxConcurrent: 1, maxRequests: 1, windowMs: 60_000 });
    const release = limiter.acquire("company:user:issue");
    release();
    expect(() => limiter.acquire("company:user:issue")).toThrow("Too many workspace file list requests");
  });
});
