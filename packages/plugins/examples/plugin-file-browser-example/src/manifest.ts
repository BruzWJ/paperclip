import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip-file-browser-example";
const FILES_SIDEBAR_SLOT_ID = "files-link";
const FILES_TAB_SLOT_ID = "files-tab";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.2.0",
  displayName: "File Browser (Example)",
  description: "Example plugin that adds a Files link under each project in the sidebar and a file browser + editor tab on the project detail page.",
  author: "Paperclip",
  categories: ["workspace", "ui"],
  capabilities: [
    "ui.sidebar.register",
    "ui.detailTab.register",
    "project.workspaces.read",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      showFilesInSidebar: {
        type: "boolean",
        title: "Show Files in Sidebar",
        default: false,
        description: "Adds the Files link under each project in the sidebar.",
      },
    },
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "projectSidebarItem",
        id: FILES_SIDEBAR_SLOT_ID,
        displayName: "Files",
        exportName: "FilesLink",
        entityTypes: ["project"],
        order: 10,
      },
      {
        type: "detailTab",
        id: FILES_TAB_SLOT_ID,
        displayName: "Files",
        exportName: "FilesTab",
        entityTypes: ["project"],
        order: 10,
      },
    ],
  },
};

export default manifest;
