import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Kitchen Sink (Example)",
  description: "Reference plugin that demonstrates Paperclip plugin UI surfaces, issue-based delegation, bridge actions, events, jobs, webhooks, tools, local workspace access, and runtime diagnostics in one place.",
  author: "Paperclip",
  categories: ["ui", "automation", "workspace", "connector"],
  capabilities: [
    "companies.read",
    "projects.read",
    "project.workspaces.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "agents.read",
    "agents.pause",
    "agents.resume",
    "goals.read",
    "goals.create",
    "goals.update",
    "activity.log.write",
    "metrics.write",
    "telemetry.track",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "events.emit",
    "jobs.schedule",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "agent.tools.register",
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.dashboardWidget.register",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      showSidebarEntry: {
        type: "boolean",
        title: "Show Sidebar Entry",
        default: DEFAULT_CONFIG.showSidebarEntry,
      },
      showSidebarPanel: {
        type: "boolean",
        title: "Show Sidebar Panel",
        default: DEFAULT_CONFIG.showSidebarPanel,
      },
      showProjectSidebarItem: {
        type: "boolean",
        title: "Show Project Sidebar Item",
        default: DEFAULT_CONFIG.showProjectSidebarItem,
      },
      enableWorkspaceDemos: {
        type: "boolean",
        title: "Enable Workspace Demos",
        default: DEFAULT_CONFIG.enableWorkspaceDemos,
      },
      enableProcessDemos: {
        type: "boolean",
        title: "Enable Process Demos",
        default: DEFAULT_CONFIG.enableProcessDemos,
        description: "Allows curated local child-process demos in project workspaces.",
      },
      secretRefExample: {
        type: "string",
        title: "Secret Reference Example",
        default: DEFAULT_CONFIG.secretRefExample,
      },
      httpDemoUrl: {
        type: "string",
        title: "HTTP Demo URL",
        default: DEFAULT_CONFIG.httpDemoUrl,
      },
      allowedCommands: {
        type: "array",
        title: "Allowed Process Commands",
        items: {
          type: "string",
          enum: DEFAULT_CONFIG.allowedCommands,
        },
        default: DEFAULT_CONFIG.allowedCommands,
      },
      workspaceScratchFile: {
        type: "string",
        title: "Workspace Scratch File",
        default: DEFAULT_CONFIG.workspaceScratchFile,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.heartbeat,
      displayName: "Demo Heartbeat",
      description: "Periodic demo job that records plugin runtime activity.",
      schedule: "*/15 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.demo,
      displayName: "Demo Ingest",
      description: "Accepts arbitrary webhook payloads and records the latest delivery in plugin state.",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.echo,
      displayName: "Kitchen Sink Echo",
      description: "Returns the provided message.",
      parametersSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
        },
        required: ["message"],
      },
    },
    {
      name: TOOL_NAMES.companySummary,
      displayName: "Kitchen Sink Company Summary",
      description: "Counts top-level issues visible through the effective run context.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Kitchen Sink",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Kitchen Sink Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
      {
        type: "companySettingsPage",
        id: SLOT_IDS.companySettingsPage,
        displayName: "Kitchen Sink",
        exportName: EXPORT_NAMES.companySettingsPage,
        routePath: "kitchen-sink",
      },
      {
        type: "dashboardWidget",
        id: SLOT_IDS.dashboardWidget,
        displayName: "Kitchen Sink",
        exportName: EXPORT_NAMES.dashboardWidget,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Kitchen Sink",
        exportName: EXPORT_NAMES.sidebar,
      },
      {
        type: "sidebarPanel",
        id: SLOT_IDS.sidebarPanel,
        displayName: "Kitchen Sink Panel",
        exportName: EXPORT_NAMES.sidebarPanel,
      },
      {
        type: "projectSidebarItem",
        id: SLOT_IDS.projectSidebarItem,
        displayName: "Kitchen Sink",
        exportName: EXPORT_NAMES.projectSidebarItem,
        entityTypes: ["project"],
      },
      {
        type: "detailTab",
        id: SLOT_IDS.projectTab,
        displayName: "Kitchen Sink",
        exportName: EXPORT_NAMES.projectTab,
        entityTypes: ["project"],
      },
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "Kitchen Sink",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
      {
        type: "issueDetailView",
        id: SLOT_IDS.issueDetailView,
        displayName: "Kitchen Sink Task View",
        exportName: EXPORT_NAMES.issueDetailView,
        entityTypes: ["issue"],
      },
      {
        type: "toolbarButton",
        id: SLOT_IDS.toolbarButton,
        displayName: "Kitchen Sink Action",
        exportName: EXPORT_NAMES.toolbarButton,
        entityTypes: ["project", "issue"],
      },
      {
        type: "contextMenuItem",
        id: SLOT_IDS.contextMenuItem,
        displayName: "Kitchen Sink Context",
        exportName: EXPORT_NAMES.contextMenuItem,
        entityTypes: ["project", "issue"],
      },
    ],
    launchers: [
      {
        id: "kitchen-sink-launcher",
        displayName: "Kitchen Sink Modal",
        placementZone: "toolbarButton",
        entityTypes: ["project", "issue"],
        action: {
          type: "openModal",
          target: EXPORT_NAMES.launcherModal,
        },
        render: {
          environment: "hostOverlay",
          bounds: "wide",
        },
      },
    ],
  },
};

export default manifest;
