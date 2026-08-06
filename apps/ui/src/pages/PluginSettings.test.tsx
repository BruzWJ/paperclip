// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSettings } from "./PluginSettings";

const mockPluginsApi = vi.hoisted(() => ({
  get: vi.fn(),
  dashboard: vi.fn(),
  logs: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  testConfig: vi.fn(),
  listLocalFolders: vi.fn(),
  configureLocalFolder: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockCompanyContext = vi.hoisted(() => ({
  selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" } as {
    id: string;
    name: string;
    issuePrefix: string;
  } | null,
  selectedCompanyId: "company-1" as string | null,
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => ({ companyPrefix: "PAP", pluginId: "plugin-1" }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: ({
    items,
    onValueChange,
  }: {
    items: Array<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
  }) => (
    <div>
      {items.map((item) => (
        <button key={item.value} type="button" onClick={() => onValueChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function basePlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin-1",
    pluginKey: "acme.remote-sandbox-provider",
    packageName: "@acme/remote-sandbox-provider",
    status: "error",
    supportsConfigTest: false,
    manifestJson: {
      displayName: "Remote Sandbox Provider",
      version: "0.1.0",
      description: "Remote sandbox environments for Paperclip.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      environmentDrivers: [
        {
          driverKey: "remote-sandbox",
          kind: "sandbox_provider",
          displayName: "Remote Cloud Sandbox",
        },
      ],
    },
    lastError: null,
    ...overrides,
  };
}

function contentFolderDeclaration() {
  return {
    folderKey: "content-root",
    displayName: "Content root",
    description: "Company-scoped local folder that stores content files.",
    access: "readWrite" as const,
    requiredDirectories: ["raw", "content"],
    requiredFiles: ["CONTENT.md", "index.md"],
  };
}

function folderStatus(overrides: Record<string, unknown> = {}) {
  return {
    folderKey: "content-root",
    configured: false,
    path: null,
    realPath: null,
    access: "readWrite",
    readable: false,
    writable: false,
    requiredDirectories: ["raw", "content"],
    requiredFiles: ["CONTENT.md", "index.md"],
    missingDirectories: ["raw", "content"],
    missingFiles: ["CONTENT.md", "index.md"],
    healthy: false,
    problems: [{ code: "not_configured", message: "No local folder path is configured." }],
    checkedAt: "2026-05-02T16:00:00.000Z",
    ...overrides,
  };
}

async function renderSettings(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PluginSettings />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  return root;
}

describe("PluginSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockPluginsApi.get.mockResolvedValue(basePlugin());
    mockPluginsApi.dashboard.mockResolvedValue(null);
    mockPluginsApi.logs.mockResolvedValue([]);
    mockPluginsApi.getConfig.mockResolvedValue(null);
    mockPluginsApi.testConfig.mockResolvedValue({ valid: true });
    mockCompanyContext.selectedCompany = { id: "company-1", name: "Paperclip", issuePrefix: "PAP" };
    mockCompanyContext.selectedCompanyId = "company-1";
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      folders: [],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("routes environment-provider plugins to instance environments when they have no instance config", async () => {
    const root = await renderSettings(container);

    expect(container.textContent).toContain("Configure this plugin from Instance Settings → Environments.");
    expect(container.textContent).toContain("registers its instance-scoped environment runtime settings there");
    const link = container.querySelector('a[href="/company/settings/instance/environments"]');
    expect(link?.textContent).toContain("Open Environments");

    await act(async () => {
      root.unmount();
    });
  });

  it("loads, tests, and saves instance config without a selected company", async () => {
    const initialConfig = {
      baseUrl: "https://connector.example",
      apiSecret: "plugin-secret",
    };
    mockCompanyContext.selectedCompany = null;
    mockCompanyContext.selectedCompanyId = null;
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      status: "ready",
      supportsConfigTest: true,
      manifestJson: {
        displayName: "Example Connector",
        version: "0.1.0",
        description: "Instance-wide external service connector.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        instanceConfigSchema: {
          type: "object",
          properties: {
            baseUrl: { type: "string", title: "Service URL" },
            apiSecret: {
              type: "string",
              title: "Service API secret",
            },
          },
          required: ["baseUrl", "apiSecret"],
        },
      },
    }));
    mockPluginsApi.getConfig.mockResolvedValue({
      id: "config-1",
      pluginId: "plugin-1",
      configJson: initialConfig,
    });
    mockPluginsApi.saveConfig.mockResolvedValue({
      id: "config-1",
      pluginId: "plugin-1",
      configJson: {
        ...initialConfig,
        baseUrl: "https://new-connector.example",
      },
    });

    const root = await renderSettings(container);

    expect(mockPluginsApi.getConfig).toHaveBeenCalledWith("plugin-1");
    expect(container.querySelector<HTMLInputElement>(
      'input[aria-label="Service API secret"]',
    )?.value).toBe("plugin-secret");
    expect(container.textContent).not.toContain("Select a company before");

    const testButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Test Configuration"),
    );
    expect(testButton).toBeDefined();
    expect(testButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      testButton!.click();
    });
    await flushReact();

    expect(mockPluginsApi.testConfig).toHaveBeenCalledWith("plugin-1", initialConfig);

    const baseUrlInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Service URL"]',
    );
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    expect(baseUrlInput).not.toBeNull();
    expect(setInputValue).toBeTruthy();

    await act(async () => {
      setInputValue!.call(baseUrlInput!, "https://new-connector.example");
      baseUrlInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Save Configuration"),
    );
    expect(saveButton).toBeDefined();
    expect(saveButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      saveButton!.click();
    });
    await flushReact();

    expect(mockPluginsApi.saveConfig).toHaveBeenCalledWith("plugin-1", {
      ...initialConfig,
      baseUrl: "https://new-connector.example",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("renders health from the dashboard response", async () => {
    mockPluginsApi.get.mockResolvedValue(basePlugin({ status: "ready" }));
    mockPluginsApi.dashboard.mockResolvedValue({
      pluginId: "plugin-1",
      worker: null,
      recentJobRuns: [],
      recentWebhookDeliveries: [],
      health: {
        pluginId: "plugin-1",
        status: "ready",
        healthy: true,
        checks: [{ name: "Remote service", passed: true }],
      },
      checkedAt: "2026-08-05T12:00:00.000Z",
    });

    const root = await renderSettings(container);
    const statusButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Status",
    );
    expect(statusButton).toBeDefined();

    await act(async () => {
      statusButton!.click();
    });
    await flushReact();

    expect(mockPluginsApi.dashboard).toHaveBeenCalledWith("plugin-1");
    expect(container.textContent).toContain("ready");
    expect(container.textContent).toContain("Remote service");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders unconfigured manifest local folders with required paths", async () => {
    const declaration = contentFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      pluginKey: "acme.knowledge-base",
      packageName: "@acme/knowledge-base-plugin",
      status: "ready",
      manifestJson: {
        displayName: "Knowledge Base",
        version: "0.1.0",
        description: "Local-file knowledge-base plugin.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      folders: [folderStatus()],
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Local folders");
    expect(container.textContent).toContain("Content root");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("No local folder path is configured.");
    expect(container.textContent).toContain("Missing directories: raw, content");
    expect(container.textContent).toContain("Missing files: CONTENT.md, index.md");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders invalid configured folders with validation problems", async () => {
    const declaration = contentFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "Knowledge Base",
        version: "0.1.0",
        description: "Local-file knowledge-base plugin.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      folders: [folderStatus({
        configured: true,
        path: "/tmp/content",
        realPath: "/tmp/content",
        readable: true,
        writable: true,
        missingDirectories: [],
        missingFiles: ["CONTENT.md"],
        problems: [{ code: "missing_file", message: "Required file is missing.", path: "CONTENT.md" }],
      })],
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("/tmp/content");
    expect(container.textContent).toContain("ReadableYes");
    expect(container.textContent).toContain("WritableYes");
    expect(container.textContent).toContain("Validation problems");
    expect(container.textContent).toContain("Required file is missing.");
    expect(container.textContent).toContain("Missing files: CONTENT.md");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not render required paths as present when the configured root cannot be inspected", async () => {
    const declaration = contentFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "Knowledge Base",
        version: "0.1.0",
        description: "Local-file knowledge-base plugin.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      folders: [folderStatus({
        configured: true,
        path: "/tmp/content-missing",
        readable: false,
        writable: false,
        missingDirectories: [],
        missingFiles: [],
        problems: [{ code: "missing", message: "Configured local folder cannot be inspected.", path: "/tmp/content-missing" }],
      })],
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Configured local folder cannot be inspected.");
    expect(container.textContent).toContain("Not inspected");
    expect(container.textContent).toContain("Configured root was not inspected.");
    expect(container.textContent).not.toContain("Present");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders healthy folders without validation problems", async () => {
    const declaration = contentFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "Knowledge Base",
        version: "0.1.0",
        description: "Local-file knowledge-base plugin.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      folders: [folderStatus({
        configured: true,
        path: "/tmp/content",
        realPath: "/private/tmp/content",
        readable: true,
        writable: true,
        missingDirectories: [],
        missingFiles: [],
        healthy: true,
        problems: [],
      })],
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Healthy");
    expect(container.textContent).toContain("Configured path");
    expect(container.textContent).toContain("/tmp/content");
    expect(container.textContent).toContain("ReadableYes");
    expect(container.textContent).toContain("WritableYes");
    expect(container.textContent).toContain("Present");
    expect(container.textContent).not.toContain("Validation problems");

    mockPluginsApi.configureLocalFolder.mockResolvedValue(folderStatus({
      configured: true,
      path: "/tmp/new-content",
      realPath: "/tmp/new-content",
      readable: true,
      writable: true,
      missingDirectories: [],
      missingFiles: [],
      healthy: true,
      problems: [],
    }));
    const pathInput = container.querySelector<HTMLInputElement>("#local-folder-content-root");
    const setInputValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    expect(pathInput).not.toBeNull();
    expect(setInputValue).toBeTruthy();
    await act(async () => {
      setInputValue!.call(pathInput!, "/tmp/new-content");
      pathInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(saveButton).toBeDefined();
    await act(async () => {
      saveButton!.click();
    });
    await flushReact();

    expect(mockPluginsApi.configureLocalFolder).toHaveBeenCalledWith(
      "plugin-1",
      "company-1",
      "content-root",
      { path: "/tmp/new-content" },
    );

    await act(async () => {
      root.unmount();
    });
  });
});
