// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterManager } from "./AdapterManager";

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

vi.mock("@/adapters/use-adapter-catalog", () => ({
  useAdapterCatalogSync: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { name: "Fixture company" } }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

describe("AdapterManager", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("shows ACPX probe failures as non-selectable diagnostics", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "ready-agent",
        label: "Ready agent",
        source: "acpx",
        modelsCount: 2,
        loaded: true,
        registryName: "ready-agent",
        capabilities: {
          supportsModelProfiles: false,
          contractVersion: "acpx-runtime/v1",
          runtimeControls: ["session/status", "session/set_config_option"],
        },
      },
      {
        type: "failed-agent",
        label: "failed-agent",
        source: "acpx",
        modelsCount: 0,
        loaded: false,
        diagnostic: {
          code: "acpx_probe_failed",
          message: "fixture local CLI is not authenticated",
        },
        registryName: "failed-agent",
      },
    ]);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AdapterManager />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Ready agent");
      expect(container.textContent).toContain("Probe failed");
      expect(container.textContent).toContain(
        "not selectable until its local ACPX probe succeeds",
      );
      expect(container.textContent).toContain(
        "fixture local CLI is not authenticated",
      );
    });
  });
});
