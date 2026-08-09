import { describe, expect, it } from "vitest";
import {
  MCP_TOOL_NAME_MAX_LENGTH,
  PLUGIN_CAPABILITIES,
  PLUGIN_LAUNCHER_PLACEMENT_ZONES,
  PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS,
  PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS,
  PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS,
  PLUGIN_STATUSES,
  PLUGIN_UI_SLOT_ENTITY_TYPES,
  PLUGIN_UI_SLOT_TYPES,
} from "../constants.js";
import {
  pluginApiRouteDeclarationSchema,
  pluginBridgeRequestSchema,
  pluginConfigRequestSchema,
  pluginDatabaseDeclarationSchema,
  pluginDisableRequestSchema,
  pluginInstallRequestSchema,
  pluginJobRunsQuerySchema,
  pluginListQuerySchema,
  pluginLocalFolderPathRequestSchema,
  pluginLogsQuerySchema,
  pluginLauncherDeclarationSchema,
  pluginLocalFolderDeclarationSchema,
  pluginManifestV1Schema,
  pluginManagedRoutineDeclarationSchema,
  pluginManagedSkillDeclarationSchema,
  pluginPackageNameSchema,
  pluginToolDeclarationSchema,
  pluginUiSlotDeclarationSchema,
  pluginUpgradeRequestSchema,
} from "./plugin.js";

describe("plugin capability constants", () => {
  it("exposes each capability once", () => {
    expect(new Set(PLUGIN_CAPABILITIES).size).toBe(PLUGIN_CAPABILITIES.length);
    expect(PLUGIN_CAPABILITIES).toContain("runtime.prompt.observe");
  });
});

describe("plugin lifecycle constants", () => {
  it("has no pending capability-escalation state", () => {
    expect(PLUGIN_STATUSES).toEqual([
      "ready",
      "disabled",
      "error",
    ]);
  });
});

describe("plugin install request validator", () => {
  it("accepts only exact npm or absolute local requests", () => {
    expect(pluginInstallRequestSchema.parse({
      source: "npm",
      packageName: "@acme/plugin-memory",
      version: "1.2.3",
    })).toEqual({
      source: "npm",
      packageName: "@acme/plugin-memory",
      version: "1.2.3",
    });
    expect(pluginInstallRequestSchema.safeParse({
      source: "local",
      path: "./plugin-memory",
    }).success).toBe(false);
    expect(pluginInstallRequestSchema.safeParse({
      source: "npm",
      packageName: "@acme/plugin-memory",
      path: "/tmp/plugin-memory",
    }).success).toBe(false);
    expect(pluginInstallRequestSchema.safeParse({
      source: "npm",
      packageName: " @acme/plugin-memory ",
    }).success).toBe(false);
  });

  it("uses one exact package-name contract", () => {
    expect(pluginPackageNameSchema.safeParse("plugin-memory").success).toBe(true);
    expect(pluginPackageNameSchema.safeParse("@acme/plugin.memory_2").success).toBe(true);
    expect(pluginPackageNameSchema.safeParse("-plugin-memory").success).toBe(false);
    expect(pluginPackageNameSchema.safeParse("@-acme/plugin-memory").success).toBe(false);
    expect(pluginPackageNameSchema.safeParse("Plugin-Memory").success).toBe(false);
    expect(pluginPackageNameSchema.safeParse(`p${"a".repeat(213)}`).success).toBe(true);
    expect(pluginPackageNameSchema.safeParse(`p${"a".repeat(214)}`).success).toBe(false);
  });
});

describe("plugin lifecycle request validators", () => {
  it("rejects ambiguous disable and upgrade inputs", () => {
    expect(pluginDisableRequestSchema.parse({})).toEqual({});
    expect(pluginDisableRequestSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(pluginUpgradeRequestSchema.parse({ version: "1.2.3" })).toEqual({ version: "1.2.3" });
    expect(pluginUpgradeRequestSchema.safeParse({ version: "latest!" }).success).toBe(false);
  });
});

describe("plugin list query validators", () => {
  it("use one strict contract for lifecycle, logs, and run history", () => {
    expect(pluginListQuerySchema.parse({ status: "ready" })).toEqual({ status: "ready" });
    expect(pluginListQuerySchema.safeParse({ status: "installed" }).success).toBe(false);
    expect(pluginLogsQuerySchema.parse({})).toEqual({ limit: "25" });
    expect(pluginLogsQuerySchema.parse({
      limit: "500",
      level: "metric",
      since: "2026-08-05T00:00:00Z",
    })).toEqual({
      limit: "500",
      level: "metric",
      since: "2026-08-05T00:00:00Z",
    });
    expect(pluginLogsQuerySchema.safeParse({ limit: "25items" }).success).toBe(false);
    expect(pluginLogsQuerySchema.safeParse({ since: "yesterday" }).success).toBe(false);
    expect(pluginJobRunsQuerySchema.parse({})).toEqual({ limit: "25" });
    expect(pluginJobRunsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(pluginJobRunsQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
  });
});

describe("plugin config request validator", () => {
  it("accepts exactly one configJson object", () => {
    expect(pluginConfigRequestSchema.parse({
      configJson: { endpoint: "https://service.example" },
    })).toEqual({
      configJson: { endpoint: "https://service.example" },
    });
    expect(pluginConfigRequestSchema.safeParse({ configJson: [] }).success).toBe(false);
    expect(pluginConfigRequestSchema.safeParse({
      configJson: {},
      extra: true,
    }).success).toBe(false);
  });
});

describe("plugin local-folder path request validator", () => {
  it("accepts only the exact path-only body", () => {
    expect(pluginLocalFolderPathRequestSchema.parse({ path: "/srv/plugin" }))
      .toEqual({ path: "/srv/plugin" });
    expect(pluginLocalFolderPathRequestSchema.safeParse({
      path: "/srv/plugin",
      access: "read",
    }).success).toBe(false);
    expect(pluginLocalFolderPathRequestSchema.safeParse({
      path: " /srv/plugin ",
    }).success).toBe(false);
  });
});

describe("plugin bridge request validator", () => {
  it("accepts one exact UI bridge envelope", () => {
    expect(pluginBridgeRequestSchema.parse({
      companyId: "11111111-1111-4111-8111-111111111111",
      params: { query: "status" },
      renderEnvironment: {
        environment: "hostOverlay",
        launcherId: "open-status",
        bounds: "wide",
      },
    })).toMatchObject({ params: { query: "status" } });
    expect(pluginBridgeRequestSchema.safeParse({
      params: {},
      unsupported: true,
    }).success).toBe(false);
    expect(pluginBridgeRequestSchema.safeParse({
      renderEnvironment: {
        environment: "hostOverlay",
        launcherId: null,
        bounds: "wide",
      },
    }).success).toBe(false);
  });
});

describe("plugin manifest validators", () => {
  const baseManifest = {
    id: "paperclip.canonical-manifest",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Canonical Manifest",
    description: "Exercises the canonical plugin manifest shape.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  it("rejects undeclared top-level fields", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      unsupportedField: true,
    }).success).toBe(false);
  });

  it("rejects undeclared fields inside manifest declarations", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: ["jobs.schedule"],
      jobs: [{
        jobKey: "sync",
        displayName: "Sync",
        undeclaredField: "not-admitted",
      }],
    }).success).toBe(false);
  });

  it("requires one valid, in-range cron schedule for every declared job", () => {
    const manifestWithSchedule = (schedule: string | undefined) => ({
      ...baseManifest,
      capabilities: ["jobs.schedule"],
      jobs: [{
        jobKey: "sync",
        displayName: "Sync",
        ...(schedule === undefined ? {} : { schedule }),
      }],
    });

    expect(pluginManifestV1Schema.safeParse(
      manifestWithSchedule("*/15 * * * *"),
    ).success).toBe(true);
    for (const schedule of [
      undefined,
      "99 * * * *",
      "0/0 * * * *",
      "10-5 * * * *",
      "0 * * * 7",
    ]) {
      expect(
        pluginManifestV1Schema.safeParse(manifestWithSchedule(schedule)).success,
        String(schedule),
      ).toBe(false);
    }
  });

  it("requires package-contained relative entrypoints", () => {
    for (const worker of ["/tmp/worker.js", "C:/tmp/worker.js", "../worker.js", "dist\\worker.js"]) {
      expect(pluginManifestV1Schema.safeParse({
        ...baseManifest,
        entrypoints: { worker },
      }).success).toBe(false);
    }
  });

  it("enforces unambiguous MCP-safe plugin tool names", () => {
    const withTool = (id: string, name: string) => ({
      ...baseManifest,
      id,
      capabilities: ["agent.tools.register"],
      tools: [{
        name,
        displayName: "Lookup",
        description: "Lookup memory",
        parametersSchema: { type: "object" },
      }],
    });

    expect(pluginManifestV1Schema.safeParse(
      withTool("paperclip.bad__id", "lookup"),
    ).success).toBe(false);
    expect(pluginManifestV1Schema.safeParse(
      withTool("paperclip.good", "bad__tool"),
    ).success).toBe(false);
    expect(pluginManifestV1Schema.safeParse(
      withTool(`p${"a".repeat(119)}`, "lookup_memory"),
    ).success).toBe(false);

    const maxBareName = `t${"a".repeat(MCP_TOOL_NAME_MAX_LENGTH - 4)}`;
    expect(`p__${maxBareName}`).toHaveLength(MCP_TOOL_NAME_MAX_LENGTH);
    expect(pluginManifestV1Schema.safeParse(
      withTool("p", maxBareName),
    ).success).toBe(true);
    expect(pluginManifestV1Schema.safeParse(
      withTool("p", `${maxBareName}a`),
    ).success).toBe(false);
  });

  it("rejects empty optional top-level declaration arrays", () => {
    const fields = [
      "jobs",
      "webhooks",
      "tools",
      "apiRoutes",
      "agents",
      "projects",
      "routines",
      "skills",
      "localFolders",
    ] as const;

    for (const field of fields) {
      const parsed = pluginManifestV1Schema.safeParse({
        ...baseManifest,
        capabilities: ["companies.read"],
        [field]: [],
      });
      expect(parsed.success, field).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.path[0] === field), field).toBe(true);
      }
    }
  });

  it("rejects empty optional UI declaration arrays", () => {
    for (const field of ["slots", "launchers"] as const) {
      const parsed = pluginManifestV1Schema.safeParse({
        ...baseManifest,
        capabilities: ["companies.read"],
        entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
        ui: { [field]: [] },
      });
      expect(parsed.success, field).toBe(false);
      if (!parsed.success) {
        expect(
          parsed.error.issues.some((issue) =>
            issue.path[0] === "ui" && issue.path[1] === field
          ),
          field,
        ).toBe(true);
      }
    }
  });

  it("requires UI declarations and the UI entrypoint to exist together", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: ["companies.read"],
      ui: {},
    }).success).toBe(false);
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: ["companies.read"],
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
    }).success).toBe(false);
  });

  it("rejects duplicate categories and capabilities", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      categories: ["automation", "automation"],
      capabilities: ["companies.read"],
    }).success).toBe(false);
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: ["companies.read", "companies.read"],
    }).success).toBe(false);
  });

  it("accepts canonical host-version and UI launcher declarations", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      minimumHostVersion: "1.0.0",
      capabilities: ["ui.action.register"],
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
      ui: {
        launchers: [{
          id: "open-canonical-page",
          displayName: "Open canonical page",
          placementZone: "globalToolbarButton",
          action: { type: "navigate", target: "/canonical" },
        }],
      },
    }).success).toBe(true);
  });

  it("rejects the undeclared iframe render path", () => {
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "unsupported-frame",
      displayName: "Unsupported frame",
      placementZone: "globalToolbarButton",
      action: { type: "openDrawer", target: "unsupported.html" },
      render: { environment: "iframe" },
    }).success).toBe(false);
  });

  it("requires the capability mapped to each declared UI slot", () => {
    const manifest = {
      ...baseManifest,
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
      ui: {
        slots: [{
          type: "page",
          id: "canonical-page",
          displayName: "Canonical page",
          exportName: "CanonicalPage",
          routePath: "canonical",
        }],
      },
    } as const;

    const missing = pluginManifestV1Schema.safeParse(manifest);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues.some((issue) =>
        issue.message.includes("ui.page.register")
      )).toBe(true);
    }

    expect(pluginManifestV1Schema.safeParse({
      ...manifest,
      capabilities: ["ui.page.register"],
    }).success).toBe(true);
  });

  it("requires the capability mapped to each declared launcher placement", () => {
    const manifest = {
      ...baseManifest,
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
      ui: {
        launchers: [{
          id: "open-sidebar",
          displayName: "Open sidebar",
          placementZone: "sidebar",
          action: { type: "navigate", target: "/canonical" },
        }],
      },
    } as const;

    const missing = pluginManifestV1Schema.safeParse(manifest);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues.some((issue) =>
        issue.message.includes("ui.sidebar.register")
      )).toBe(true);
    }

    expect(pluginManifestV1Schema.safeParse({
      ...manifest,
      capabilities: ["ui.sidebar.register"],
    }).success).toBe(true);
  });

  it("rejects secret references in instance configuration", () => {
    const result = pluginManifestV1Schema.safeParse({
      id: "paperclip.direct-config",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Direct Config",
      description: "Reads credentials directly from its instance configuration.",
      author: "Paperclip",
      categories: ["connector"],
      capabilities: ["http.outbound"],
      entrypoints: { worker: "./dist/worker.js" },
      instanceConfigSchema: {
        type: "object",
        properties: {
          apiKey: { type: "string", format: "secret-ref" },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects tool names containing the namespace separator", () => {
    const tool = {
      name: "search__query",
      displayName: "Query",
      description: "Query an external index",
      parametersSchema: { type: "object" },
    };
    expect(pluginToolDeclarationSchema.safeParse(tool).success).toBe(false);
    expect(pluginToolDeclarationSchema.safeParse({
      ...tool,
      name: "search_query",
    }).success).toBe(true);
  });

  it("accepts only boolean bootstrap tool enablement", () => {
    const tool = {
      name: "search_query",
      displayName: "Query",
      description: "Query an external index",
      parametersSchema: { type: "object" },
    };
    expect(pluginToolDeclarationSchema.safeParse({
      ...tool,
      bootstrapEnabled: true,
    }).success).toBe(true);
    expect(pluginToolDeclarationSchema.safeParse({
      ...tool,
      bootstrapEnabled: false,
    }).success).toBe(true);
    expect(pluginToolDeclarationSchema.safeParse({
      ...tool,
      bootstrapEnabled: "true",
    }).success).toBe(false);
  });

  it("requires the ordinary HTTP capability before private-network access", () => {
    const base = {
      id: "paperclip.private-service",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Private Service",
      description: "Connects to an operator-hosted private service.",
      author: "Paperclip",
      categories: ["connector"],
      entrypoints: { worker: "./dist/worker.js" },
    } as const;

    expect(pluginManifestV1Schema.safeParse({
      ...base,
      capabilities: ["http.private-network"],
    }).success).toBe(false);
    expect(pluginManifestV1Schema.safeParse({
      ...base,
      capabilities: ["http.outbound", "http.private-network"],
    }).success).toBe(true);
  });

  it("accepts dashboard plugins without unrelated access or authorization capabilities", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.dashboard",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Dashboard",
      description: "Dashboard-only plugin without access or authorization host APIs.",
      author: "Paperclip",
      categories: ["ui"],
      capabilities: ["ui.dashboardWidget.register"],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui.js",
      },
      ui: {
        slots: [
          {
            type: "dashboardWidget",
            id: "dashboard",
            displayName: "Dashboard",
            exportName: "Dashboard",
          },
        ],
      },
    });

    expect(parsed.capabilities).toEqual(["ui.dashboardWidget.register"]);
  });

});

describe("plugin nested declaration lists", () => {
  it("rejects empty optional lists in nested declarations", () => {
    expect(pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "sync",
      title: "Sync",
      variables: [],
    }).success).toBe(false);
    expect(pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "sync",
      title: "Sync",
      triggers: [],
    }).success).toBe(false);
    expect(pluginLocalFolderDeclarationSchema.safeParse({
      folderKey: "workspace",
      displayName: "Workspace",
      requiredDirectories: [],
    }).success).toBe(false);
    expect(pluginLocalFolderDeclarationSchema.safeParse({
      folderKey: "workspace",
      displayName: "Workspace",
      requiredFiles: [],
    }).success).toBe(false);
    expect(pluginManagedSkillDeclarationSchema.safeParse({
      skillKey: "sync",
      displayName: "Sync",
      files: [],
    }).success).toBe(false);
    expect(pluginUiSlotDeclarationSchema.safeParse({
      type: "page",
      id: "sync",
      displayName: "Sync",
      exportName: "Sync",
      entityTypes: [],
    }).success).toBe(false);
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "sync",
      displayName: "Sync",
      placementZone: "sidebar",
      entityTypes: [],
      action: { type: "navigate", target: "/sync" },
    }).success).toBe(false);
    expect(pluginDatabaseDeclarationSchema.safeParse({
      migrationsDir: "migrations",
      coreReadTables: [],
    }).success).toBe(false);
  });
});

describe("plugin API route validators", () => {
  const route = {
    routeKey: "issue.summary",
    method: "GET",
    path: "/issues/:issueId/summary",
    companyResolution: { from: "issue", param: "issueId" },
  } as const;

  it("uses one board-authenticated route contract without a manifest auth switch", () => {
    expect(pluginApiRouteDeclarationSchema.safeParse(route).success).toBe(true);
    expect(pluginApiRouteDeclarationSchema.safeParse({
      ...route,
      auth: "board",
    }).success).toBe(false);
    expect(pluginApiRouteDeclarationSchema.safeParse({
      ...route,
      auth: "webhook",
    }).success).toBe(false);
  });

  it("requires an explicit company resolution", () => {
    const { companyResolution: _, ...withoutResolution } = route;
    expect(pluginApiRouteDeclarationSchema.safeParse(withoutResolution).success).toBe(false);
  });

  it("requires issue resolution to reference an exact path parameter", () => {
    expect(pluginApiRouteDeclarationSchema.safeParse({
      ...route,
      companyResolution: { from: "issue", param: "otherIssueId" },
    }).success).toBe(false);
    expect(pluginApiRouteDeclarationSchema.safeParse(route).success).toBe(true);
  });

  it("rejects body-based company resolution for GET routes", () => {
    expect(pluginApiRouteDeclarationSchema.safeParse({
      ...route,
      companyResolution: { from: "body", key: "companyId" },
    }).success).toBe(false);
    expect(pluginApiRouteDeclarationSchema.safeParse({
      ...route,
      method: "POST",
      companyResolution: { from: "body", key: "companyId" },
    }).success).toBe(true);
  });
});

describe("plugin managed routine validators", () => {
  it("accepts core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.parse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "default" },
    });

    expect(parsed.issueTemplate?.surfaceVisibility).toBe("default");
  });

  it("rejects non-core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "normal" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("plugin managed skill validators", () => {
  const baseManifest = {
    id: "paperclip.test-managed-skills",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills",
    description: "Managed skills test plugin.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  it("requires skills.managed when managed skills are declared", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: [],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("skills.managed"))).toBe(true);
  });

  it("accepts managed skills with the skills.managed capability", () => {
    const parsed = pluginManifestV1Schema.parse({
      ...baseManifest,
      capabilities: ["skills.managed"],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.skills?.[0]?.skillKey).toBe("wiki-maintainer");
  });
});

describe("plugin UI slot validators", () => {
  const uiManifest = {
    id: "paperclip.ui-slots",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "UI Slots",
    description: "Exercises canonical UI slot topology.",
    author: "Paperclip",
    categories: ["automation"],
  } as const;

  it("publishes only production-mounted slot, launcher, and entity surfaces", () => {
    expect(PLUGIN_UI_SLOT_TYPES).toEqual([
      "page",
      "detailTab",
      "issueDetailView",
      "dashboardWidget",
      "sidebar",
      "routeSidebar",
      "sidebarPanel",
      "projectSidebarItem",
      "globalToolbarButton",
      "toolbarButton",
      "settingsPage",
      "companySettingsPage",
    ]);
    expect(PLUGIN_LAUNCHER_PLACEMENT_ZONES).toEqual([
      "sidebar",
      "globalToolbarButton",
      "toolbarButton",
    ]);
    expect(PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS).toEqual(["hostOverlay"]);
    expect(PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS).toEqual([
      "dashboard",
      "timeline",
      "onboarding",
      "companies",
      "company",
      "skills",
      "org",
      "agents",
      "projects",
      "issues",
      "search",
      "routines",
      "artifacts",
      "approvals",
      "costs",
      "activity",
      "inbox",
      "u",
      "design-guide",
      "instance",
    ]);
    expect(PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS).toEqual([
      "members",
      "invites",
      "secrets",
      "instance",
    ]);
    expect(PLUGIN_UI_SLOT_ENTITY_TYPES).toEqual([
      "project",
      "issue",
    ]);
  });

  it("requires page slots to declare their canonical routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "page",
      id: "wiki-page",
      displayName: "Wiki",
      exportName: "WikiPage",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe("page slots require routePath");
  });

  it("accepts route-scoped sidebar slots with a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
      routePath: "wiki",
    });

    expect(parsed.routePath).toBe("wiki");
  });

  it("requires route-scoped sidebar slots to declare a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe("routeSidebar slots require routePath");
  });

  it("keeps reserved company route protection for route-scoped sidebars", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "company-route-sidebar",
      displayName: "Company Sidebar",
      exportName: "CompanySidebar",
      routePath: "company",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });

  it("rejects retired workspace entity types", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "detailTab",
      id: "workspace-inspector",
      displayName: "Inspector",
      exportName: "WorkspaceInspector",
      entityTypes: ["execution_workspace", "project_workspace"],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects entity targets that have no mount for the selected slot", () => {
    for (const declaration of [
      {
        type: "issueDetailView",
        id: "project-inline",
        displayName: "Project inline",
        exportName: "ProjectInline",
        entityTypes: ["project"],
      },
      {
        type: "projectSidebarItem",
        id: "issue-sidebar",
        displayName: "Issue sidebar",
        exportName: "IssueSidebar",
        entityTypes: ["issue"],
      },
      {
        type: "toolbarButton",
        id: "project-workspace-action",
        displayName: "Workspace action",
        exportName: "WorkspaceAction",
        entityTypes: ["project_workspace"],
      },
    ]) {
      expect(pluginUiSlotDeclarationSchema.safeParse(declaration).success).toBe(false);
    }
  });

  it("rejects entityTypes on global slots and launcher placements", () => {
    expect(pluginUiSlotDeclarationSchema.safeParse({
      type: "dashboardWidget",
      id: "scoped-dashboard",
      displayName: "Scoped dashboard",
      exportName: "ScopedDashboard",
      entityTypes: ["issue"],
    }).success).toBe(false);
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "scoped-sidebar",
      displayName: "Scoped sidebar",
      placementZone: "sidebar",
      entityTypes: ["issue"],
      action: { type: "navigate", target: "/canonical" },
    }).success).toBe(false);
  });

  it("limits toolbar launchers to entity pages where the launcher outlet mounts", () => {
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "workspace-launcher",
      displayName: "Workspace launcher",
      placementZone: "toolbarButton",
      entityTypes: ["execution_workspace"],
      action: { type: "navigate", target: "/canonical" },
    }).success).toBe(false);
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "issue-launcher",
      displayName: "Issue launcher",
      placementZone: "toolbarButton",
      entityTypes: ["issue"],
      action: { type: "navigate", target: "/canonical" },
    }).success).toBe(true);
  });

  it("accepts only concrete launcher action and render metadata", () => {
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "open-overlay",
      displayName: "Open overlay",
      placementZone: "globalToolbarButton",
      action: { type: "openModal", target: "Overlay" },
      render: { environment: "hostOverlay", bounds: "wide" },
    }).success).toBe(true);

    for (const action of [
      { type: "navigate", target: "/canonical" },
      { type: "deepLink", target: "https://example.com" },
      { type: "performAction", target: "sync" },
    ] as const) {
      expect(pluginLauncherDeclarationSchema.safeParse({
        id: `invalid-render-${action.type}`,
        displayName: "Invalid render metadata",
        placementZone: "globalToolbarButton",
        action,
        render: { environment: "hostOverlay" },
      }).success).toBe(false);
    }

    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "missing-overlay-render",
      displayName: "Missing overlay render",
      placementZone: "globalToolbarButton",
      action: { type: "openPopover", target: "Popover" },
    }).success).toBe(false);
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "unmounted-environment",
      displayName: "Unmounted environment",
      placementZone: "globalToolbarButton",
      action: { type: "openDrawer", target: "Drawer" },
      render: { environment: "hostRoute" },
    }).success).toBe(false);
  });

  it("keeps action parameters and external URLs action-specific", () => {
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "action-with-params",
      displayName: "Action with params",
      placementZone: "sidebar",
      action: { type: "performAction", target: "sync", params: { force: true } },
    }).success).toBe(true);
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "navigation-with-ignored-params",
      displayName: "Navigation with params",
      placementZone: "sidebar",
      action: { type: "navigate", target: "/canonical", params: { ignored: true } },
    }).success).toBe(false);
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "relative-deep-link",
      displayName: "Relative deep link",
      placementZone: "sidebar",
      action: { type: "deepLink", target: "/canonical" },
    }).success).toBe(false);
    expect(pluginLauncherDeclarationSchema.safeParse({
      id: "protocol-relative-navigation",
      displayName: "Protocol-relative navigation",
      placementZone: "sidebar",
      action: { type: "navigate", target: "//example.com" },
    }).success).toBe(false);
  });

  it("accepts company settings page slots with a non-core settings route", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "companySettingsPage",
      id: "permissions-settings",
      displayName: "Permissions",
      exportName: "PermissionsSettingsPage",
      routePath: "permissions",
    });

    expect(parsed.routePath).toBe("permissions");
  });

  it("prevents company settings page slots from shadowing core settings routes", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "companySettingsPage",
      id: "instance-settings",
      displayName: "Instance",
      exportName: "InstanceSettingsPage",
      routePath: "instance",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });

  it("requires each routeSidebar to pair with exactly one page route", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...uiManifest,
      capabilities: ["ui.sidebar.register"],
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
      ui: {
        slots: [{
          type: "routeSidebar",
          id: "wiki-sidebar",
          displayName: "Wiki Sidebar",
          exportName: "WikiSidebar",
          routePath: "wiki",
        }],
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) =>
      issue.message.includes("paired with one page")
    )).toBe(true);
  });

  it("accepts one routeSidebar paired with one page using the same routePath", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...uiManifest,
      capabilities: ["ui.page.register", "ui.sidebar.register"],
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
      ui: {
        slots: [
          {
            type: "page",
            id: "wiki-page",
            displayName: "Wiki",
            exportName: "WikiPage",
            routePath: "wiki",
          },
          {
            type: "routeSidebar",
            id: "wiki-sidebar",
            displayName: "Wiki Sidebar",
            exportName: "WikiSidebar",
            routePath: "wiki",
          },
        ],
      },
    }).success).toBe(true);
  });

  it("rejects a second routeSidebar for the same page route", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...uiManifest,
      capabilities: ["ui.page.register", "ui.sidebar.register"],
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
      ui: {
        slots: [
          {
            type: "page",
            id: "wiki-page",
            displayName: "Wiki",
            exportName: "WikiPage",
            routePath: "wiki",
          },
          ...["primary", "secondary"].map((id) => ({
            type: "routeSidebar",
            id: `${id}-sidebar`,
            displayName: id,
            exportName: `${id}Sidebar`,
            routePath: "wiki",
          })),
        ],
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) =>
      issue.message.includes("sole sidebar")
    )).toBe(true);
  });

  it("rejects duplicate page route claims inside one manifest", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...uiManifest,
      capabilities: ["ui.page.register"],
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
      ui: {
        slots: ["one", "two"].map((id) => ({
          type: "page",
          id,
          displayName: id,
          exportName: `${id}Page`,
          routePath: "wiki",
        })),
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) =>
      issue.message.includes("Duplicate page routePath")
    )).toBe(true);
  });
});
