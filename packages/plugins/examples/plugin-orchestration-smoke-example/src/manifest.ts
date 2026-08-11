import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-orchestration-smoke-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Plugin Task Runtime Smoke Example",
  description: "First-party smoke plugin that exercises canonical plugin-created ordinary tasks.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "tasks.read",
    "tasks.create",
    "ui.dashboardWidget.register",
    "ui.detailTab.register",
    "instance.settings.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  database: {
    namespaceSlug: "orchestration_smoke",
    migrationsDir: "migrations",
    coreReadTables: ["tasks"]
  },
  apiRoutes: [
    {
      routeKey: "initialize",
      method: "POST",
      path: "/tasks/:taskId/smoke",
      companyResolution: { from: "task", param: "taskId" }
    },
    {
      routeKey: "summary",
      method: "GET",
      path: "/tasks/:taskId/smoke",
      companyResolution: { from: "task", param: "taskId" }
    }
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Orchestration Smoke Health",
        exportName: "DashboardWidget"
      },
      {
        type: "taskDetailView",
        id: "task-panel",
        displayName: "Orchestration Smoke",
        exportName: "TaskPanel",
        entityTypes: ["task"]
      },
      {
        type: "settingsPage",
        id: "settings",
        displayName: "Orchestration Smoke",
        exportName: "SettingsPage"
      }
    ]
  }
};

export default manifest;
