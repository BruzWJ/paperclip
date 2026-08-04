// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAdapterCatalogSync } from "./use-adapter-catalog";
import { listUIAdapters, syncServerAdapters } from "./registry";

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

function Probe({ enabled }: { enabled: boolean }) {
  const catalog = useAdapterCatalogSync({ enabled });
  const types = listUIAdapters().map((adapter) => adapter.type);
  return (
    <div data-testid="adapter-types">
      {catalog.length}:{types.join(",")}
    </div>
  );
}

describe("useAdapterCatalogSync", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncServerAdapters([{ type: "codex", label: "Codex" }]);
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
    syncServerAdapters([{ type: "codex", label: "Codex" }]);
    container.remove();
    vi.clearAllMocks();
  });

  it("does not fetch the catalog when disabled", () => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe enabled={false} />
        </QueryClientProvider>,
      );
    });

    expect(mockAdaptersApi.list).not.toHaveBeenCalled();
  });

  it("synchronizes exactly the server-admitted ACPX catalog", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "codex",
        label: "Codex",
        source: "acpx",
        modelsCount: 2,
        loaded: true,
        drivers: ["local"],
        registryName: "codex",
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: ["session/status", "session/set_config_option"],
          supportsModelProfiles: false,
        },
      },
    ]);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe enabled />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="adapter-types"]')?.textContent,
      ).toBe("1:codex");
    });
    expect(listUIAdapters()).toEqual([
      expect.objectContaining({ type: "codex", drivers: ["local"] }),
    ]);
  });

  it("does not synchronize a failed ACPX probe into selectable UI adapters", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "visible-agent",
        label: "Visible agent",
        source: "acpx",
        modelsCount: 0,
        loaded: true,
        drivers: ["local"],
        registryName: "visible-agent",
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: ["session/status", "session/set_config_option"],
          supportsModelProfiles: false,
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
          <Probe enabled />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="adapter-types"]')?.textContent,
      ).toBe("1:visible-agent");
      expect(listUIAdapters().map((adapter) => adapter.type)).toEqual(["visible-agent"]);
    });
  });
});
