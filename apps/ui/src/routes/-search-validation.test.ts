import { describe, expect, it } from "vitest";
import { validateAuthSearch } from "./auth";
import { validateCliAuthSearch } from "./cli-auth/$id";
import { validateArtifactsSearch } from "./_authenticated/$companyId/artifacts";
import { validateNewAgentSearch } from "./_authenticated/$companyId/agents/new";
import { validateCompanySearch } from "./_authenticated/$companyId/search";
import { validateSecretsSearch } from "./_authenticated/$companyId/company/settings/secrets";
import { validateRoutinesSearch } from "./_authenticated/$companyId/routines/index";
import { validateTasksSearch } from "./_authenticated/$companyId/tasks/index";
import { validateProjectDetailSearch } from "./_authenticated/$companyId/projects/$projectId/index";
import { validateApprovalDetailSearch } from "./_authenticated/$companyId/approvals/$approvalId";

const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const LABEL_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "44444444-4444-4444-8444-444444444444";
const MIXED_CASE_UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("public route search validation", () => {
  it("accepts exact internal redirects, challenge tokens, and ACPX names", () => {
    expect(
      validateAuthSearch({
        next: `/cli-auth/${TASK_ID}?token=pcp_cli_auth_exact`,
      }),
    ).toEqual({
      next: `/cli-auth/${TASK_ID}?token=pcp_cli_auth_exact`,
    });
    expect(validateCliAuthSearch({ token: "pcp_cli_auth_exact" })).toEqual({
      token: "pcp_cli_auth_exact",
    });
    expect(validateNewAgentSearch({ adapterType: "codex" })).toEqual({
      adapterType: "codex",
    });
  });

  it.each([
    () => validateAuthSearch({ next: "https://example.test" }),
    () => validateAuthSearch({ next: "//example.test" }),
    () => validateAuthSearch({ next: "/company//dashboard" }),
    () => validateAuthSearch({ next: "/company%2Fdashboard" }),
    () => validateAuthSearch({ next: "/company/" }),
    () => validateAuthSearch({ next: "/company", extra: "value" }),
    () => validateCliAuthSearch({}),
    () => validateCliAuthSearch({ token: " short-token" }),
    () => validateCliAuthSearch({ token: "short" }),
    () =>
      validateCliAuthSearch({ token: "pcp_cli_auth_exact", extra: "value" }),
    () => validateNewAgentSearch({ adapterType: " codex" }),
    () => validateNewAgentSearch({ adapterType: "" }),
    () => validateNewAgentSearch({ unknown: "codex" }),
  ])("rejects public route aliases %#", (validate) => {
    expect(validate).toThrow(/Invalid search parameter/);
  });
});

describe("company search route validation", () => {
  it("preserves free text and accepts only exact filter identities", () => {
    expect(
      validateCompanySearch({
        q: "auth owner:me remains text",
        scope: "tasks",
        sort: "updated",
        status: ["todo", "blocked"],
        priority: "high",
        ownerAgentId: OWNER_ID,
        projectId: PROJECT_ID,
        labelId: LABEL_ID,
        updatedWithin: "7d",
        updatedAfter: "2026-08-11T12:00:00.000Z",
      }),
    ).toEqual({
      q: "auth owner:me remains text",
      scope: "tasks",
      sort: "updated",
      status: ["todo", "blocked"],
      priority: ["high"],
      ownerAgentId: OWNER_ID,
      projectId: PROJECT_ID,
      labelId: LABEL_ID,
      updatedWithin: "7d",
      updatedAfter: "2026-08-11T12:00:00.000Z",
    });
  });

  it("accepts an exact opaque user owner id as the sole owner filter", () => {
    expect(validateCompanySearch({ ownerUserId: "user-1" })).toMatchObject({
      ownerUserId: "user-1",
      ownerAgentId: undefined,
    });
  });

  it.each([
    { unknown: "value" },
    { q: true },
    { q: " auth" },
    { scope: "everything" },
    { status: [] },
    { status: ["todo", "todo"] },
    { status: "todo,blocked" },
    { ownerAgentId: "null" },
    { ownerAgentId: "33333333-3333-4333-8333-AAAAAAAAAAAA" },
    { ownerAgentId: OWNER_ID, ownerUserId: "user-1" },
    { ownerUserId: " user-1" },
    { projectId: "Paperclip App" },
    { labelId: "bug" },
    { updatedWithin: "soon" },
    { updatedAfter: "2026-08-11" },
  ])("rejects invalid or compatibility search input %#", (search) => {
    expect(() => validateCompanySearch(search)).toThrow(
      /Invalid search parameter/,
    );
  });
});

describe("artifact route search validation", () => {
  it("accepts its canonical search shape", () => {
    expect(
      validateArtifactsSearch({
        kind: "image",
        q: "render output",
        groupBy: "task",
        groupTaskId: TASK_ID,
      }),
    ).toEqual({
      kind: "image",
      q: "render output",
      groupBy: "task",
      groupTaskId: TASK_ID,
    });
  });

  it.each([
    { unknown: "value" },
    { kind: "media" },
    { q: " render" },
    { groupBy: "agent" },
    { groupTaskId: "PAP-1" },
    { groupTaskId: "44444444-4444-4444-8444-AAAAAAAAAAAA" },
    { groupBy: "none", groupTaskId: TASK_ID },
  ])("rejects invalid artifact search input %#", (search) => {
    expect(() => validateArtifactsSearch(search)).toThrow(
      /Invalid search parameter/,
    );
  });
});

describe("company page selector validation", () => {
  it("accepts only canonical task, routine folder, and secret path selectors", () => {
    expect(
      validateTasksSearch({
        q: "status review",
        participantAgentId: OWNER_ID,
        ownerUserId: "user-1",
      }),
    ).toEqual({
      q: "status review",
      participantAgentId: OWNER_ID,
      ownerAgentId: undefined,
      ownerUserId: "user-1",
    });
    expect(validateRoutinesSearch({ folder: PROJECT_ID, tab: "runs" })).toEqual(
      {
        folder: PROJECT_ID,
        tab: "runs",
      },
    );
    expect(validateRoutinesSearch({ folder: "unfiled" })).toMatchObject({
      folder: "unfiled",
    });
    expect(validateSecretsSearch({ path: "team & ops/production" })).toEqual({
      path: "team & ops/production",
    });
  });

  it.each([
    () =>
      validateTasksSearch({
        participantAgentId: MIXED_CASE_UUID.toUpperCase(),
      }),
    () => validateTasksSearch({ owner: "__me" }),
    () => validateTasksSearch({ ownerUserId: " user-1" }),
    () => validateTasksSearch({ q: "Status review" }),
    () => validateTasksSearch({ extra: "value" }),
    () => validateRoutinesSearch({ folder: "all" }),
    () => validateRoutinesSearch({ folder: "not-a-folder-id" }),
    () => validateRoutinesSearch({ folder: MIXED_CASE_UUID.toUpperCase() }),
    () => validateSecretsSearch({ path: "/production" }),
    () => validateSecretsSearch({ path: "production/" }),
    () => validateSecretsSearch({ path: "production//tokens" }),
    () => validateSecretsSearch({ path: " production" }),
  ])("rejects selector aliases %#", (validate) => {
    expect(validate).toThrow(/Invalid search parameter/);
  });
});

describe("company entity detail search validation", () => {
  it("accepts only the exact project plugin tab and approval resolution tokens", () => {
    expect(
      validateProjectDetailSearch({
        tab: "plugin:example.plugin:project-inspector",
      }),
    ).toEqual({ tab: "plugin:example.plugin:project-inspector" });
    expect(validateProjectDetailSearch({})).toEqual({ tab: undefined });
    expect(validateApprovalDetailSearch({ resolved: "approved" })).toEqual({
      resolved: "approved",
    });
    expect(validateApprovalDetailSearch({})).toEqual({
      resolved: undefined,
    });
  });

  it.each([
    () => validateProjectDetailSearch({ tab: "overview" }),
    () => validateProjectDetailSearch({ tab: "plugin:example.plugin" }),
    () => validateProjectDetailSearch({ tab: "plugin:Example:slot" }),
    () => validateProjectDetailSearch({ tab: " plugin:example:slot" }),
    () =>
      validateProjectDetailSearch({
        tab: "plugin:example:slot",
        legacyTab: "slot",
      }),
    () => validateApprovalDetailSearch({ resolved: "accepted" }),
    () =>
      validateApprovalDetailSearch({
        resolved: "approved",
        status: "approved",
      }),
  ])("rejects detail search aliases %#", (validate) => {
    expect(validate).toThrow(/Invalid search parameter/);
  });
});
