import { describe, expect, it } from "vitest";
import { API } from "./api.js";
import {
  refreshSummarySlotSchema,
  summarySlotScopeSelectorSchema,
} from "./validators/summary-slot.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

describe("summary slot shared contract", () => {
  it("defines stable summary slot API path constants", () => {
    expect(API.summarySlot).toBe("/api/companies/:companyId/summary-slots/:scopeKind/:slotKey");
    expect(API.summarySlotRevisions).toBe(
      "/api/companies/:companyId/summary-slots/:scopeKind/:slotKey/revisions",
    );
    expect(API.summarySlotRefresh).toBe(
      "/api/companies/:companyId/summary-slots/:scopeKind/:slotKey/refresh",
    );
  });

  it("allows scoped project and project-workspace header slots", () => {
    expect(summarySlotScopeSelectorSchema.parse({
      scopeKind: "project",
      scopeId,
      slotKey: "header",
    })).toEqual({ scopeKind: "project", scopeId, slotKey: "header" });

    expect(summarySlotScopeSelectorSchema.parse({
      scopeKind: "project_workspace",
      scopeId,
      slotKey: "header",
    })).toEqual({ scopeKind: "project_workspace", scopeId, slotKey: "header" });
  });

  it("treats workspaces_overview as a company-scoped singleton", () => {
    expect(summarySlotScopeSelectorSchema.parse({
      scopeKind: "workspaces_overview",
      slotKey: "header",
    })).toEqual({ scopeKind: "workspaces_overview", slotKey: "header" });

    expect(() => summarySlotScopeSelectorSchema.parse({
      scopeKind: "workspaces_overview",
      scopeId,
      slotKey: "header",
    })).toThrow("workspaces_overview summary slots must not include scopeId");
  });

  it("requires scope ids for entity-backed scopes", () => {
    expect(() => summarySlotScopeSelectorSchema.parse({
      scopeKind: "project",
      slotKey: "header",
    })).toThrow("project summary slots require scopeId");
    expect(() => summarySlotScopeSelectorSchema.parse({
      scopeKind: "project_workspace",
      slotKey: "header",
    })).toThrow("project_workspace summary slots require scopeId");
  });

  it("accepts an explicit owner only for initial routine configuration", () => {
    expect(refreshSummarySlotSchema.parse({
      scopeId,
      ownerAgentId: agentId,
    })).toEqual({
      scopeId,
      ownerAgentId: agentId,
    });
    expect(refreshSummarySlotSchema.parse({ scopeId })).toEqual({ scopeId });
  });
});
