// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginRecordDto } from "@paperclipai/shared";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouter } from "@/test/TestRouter";
import { getRouteComponent } from "@/test/route-component";
import { Route } from ".";

const PluginManager = getRouteComponent(Route);

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PLUGINS_PATH = `/${COMPANY_ID}/company/settings/instance/plugins`;

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));
const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listCatalog: vi.fn(),
  install: vi.fn(),
  installCatalog: vi.fn(),
  uninstall: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("@/hooks/useCurrentUserId", () => ({
  useCurrentUserId: () => "user-1",
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Fixture company",
      taskPrefix: "FIX",
    },
  }),
}));
vi.mock("sonner", () => ({
  toast: {
    error: mockPushToast,
    info: mockPushToast,
    success: mockPushToast,
  },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installedPlugin(overrides: Partial<PluginRecordDto> = {}): PluginRecordDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pluginKey: "paperclip.agentmemory",
    packageName: "@paperclipai/plugin-agentmemory",
    source: "local",
    packagePath: "/repo/packages/plugins/agentmemory-plugin",
    status: "disabled",
    installOrder: 1,
    manifestJson: {
      id: "paperclip.agentmemory",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "AgentMemory",
      description: "Automatic memory capture and recall.",
      author: "Paperclip",
      categories: ["connector"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
    },
    lastError: null,
    installedAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

const catalogEntries = [
  {
    packageName: "@paperclipai/plugin-agentmemory",
    version: "0.1.0",
    displayName: "AgentMemory",
    description: "Automatic memory capture and recall.",
    relativePath: "packages/plugins/agentmemory-plugin",
    kind: "first_party",
    built: true,
  },
  {
    packageName: "@paperclipai/plugin-authoring-smoke-example",
    version: "0.1.0",
    displayName: "Plugin Authoring Smoke Example",
    description: "A development plugin example.",
    relativePath: "packages/plugins/examples/plugin-authoring-smoke-example",
    kind: "example",
    built: false,
  },
];

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("PluginManager", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    mockPluginsApi.list.mockResolvedValue([]);
    mockPluginsApi.listCatalog.mockResolvedValue(catalogEntries);
    mockPluginsApi.install.mockResolvedValue(installedPlugin());
    mockPluginsApi.installCatalog.mockResolvedValue(installedPlugin());
    mockPluginsApi.uninstall.mockResolvedValue(undefined);
    mockPluginsApi.enable.mockResolvedValue(installedPlugin({ status: "ready" }));
    mockPluginsApi.disable.mockResolvedValue(installedPlugin());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderPage() {
    await act(async () => {
      root.render(
        <TestRouter initialEntries={[PLUGINS_PATH]}>
          <QueryClientProvider client={queryClient}>
            <PluginManager />
          </QueryClientProvider>
        </TestRouter>,
      );
    });
    await flushReact();
  }

  it("shows the local catalog to admins and installs an unbuilt entry by package name", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    });
    mockPluginsApi.list.mockResolvedValue([installedPlugin()]);
    mockPluginsApi.installCatalog.mockReturnValue(new Promise(() => undefined));

    await renderPage();

    await vi.waitFor(() => {
      expect(mockPluginsApi.listCatalog).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Available Plugins");
      expect(container.textContent).toContain("First-party");
      expect(container.textContent).toContain("Example");
      expect(container.textContent).toContain("Builds on install");
      expect(container.textContent).toContain("Review configuration");
    });

    const installButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Install Plugin Authoring Smoke Example"]',
    );
    expect(installButton).not.toBeNull();

    await act(async () => installButton!.click());
    await vi.waitFor(() => {
      expect(mockPluginsApi.installCatalog).toHaveBeenCalledWith(
        "@paperclipai/plugin-authoring-smoke-example",
      );
      expect(installButton!.textContent).toContain("Building and installing…");
    });
    expect(installButton!.disabled).toBe(true);
  });

  it("installs an npm package through the shared form dialog", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    });

    await renderPage();
    let openDialog: HTMLButtonElement | undefined;
    await vi.waitFor(() => {
      openDialog = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Install Plugin",
      );
      expect(openDialog).not.toBeUndefined();
    });
    await act(async () => openDialog?.click());
    await flushReact();

    let packageInput: HTMLInputElement | null = null;
    await vi.waitFor(() => {
      packageInput = document.querySelector<HTMLInputElement>("#packageName");
      expect(packageInput).not.toBeNull();
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        packageInput,
        "@example/plugin",
      );
      packageInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const submit = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Install",
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => submit?.click());
    await vi.waitFor(() => {
      expect(mockPluginsApi.install).toHaveBeenCalledWith({
        source: "npm",
        packageName: "@example/plugin",
      });
    });
  });

  it("keeps non-admin plugin management read-only and never fetches the catalog", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "member-1",
      isInstanceAdmin: false,
      companyIds: [COMPANY_ID],
    });
    mockPluginsApi.list.mockResolvedValue([
      installedPlugin({
        status: "ready",
        manifestJson: {
          ...installedPlugin().manifestJson,
          displayName: "Installed fixture",
        },
      }),
    ]);

    await renderPage();

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Installed fixture");
      expect(container.textContent).toContain(
        "Plugin installation and lifecycle controls are available only to instance admins.",
      );
    });
    expect(mockPluginsApi.listCatalog).not.toHaveBeenCalled();
    expect(container.querySelector('[title="Disable"]')).toBeNull();
    expect(container.querySelector('[title="Uninstall"]')).toBeNull();
    expect(container.querySelector('a[href*="/plugins/"]')).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Install Plugin"),
      ),
    ).toBe(false);
  });

  it("shows catalog installation failures inline", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    });
    mockPluginsApi.installCatalog.mockRejectedValue(new Error("Automatic build failed"));

    await renderPage();

    let installButton: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      installButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Install Plugin Authoring Smoke Example"]',
      );
      expect(installButton).not.toBeNull();
    });
    await act(async () => installButton!.click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Automatic build failed");
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
