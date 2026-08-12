// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAdapterCatalogSyncState } from "./use-adapter-catalog";
import { listUIAdapters, syncServerAdapters } from "./registry";
import { queryKeys } from "@/lib/queryKeys";
import { useAdapterConfigOptions } from "./acpx-config-options";

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

function Probe({ enabled }: { enabled: boolean }) {
  const { adapters } = useAdapterCatalogSyncState({ enabled });
  const types = listUIAdapters().map((adapter) => adapter.type);
  return (
    <div data-testid="adapter-types">
      {adapters.length}:{types.join(",")}
    </div>
  );
}

function OptionsProbe({ adapterType }: { adapterType: string }) {
  const { configOptions, isLoading } = useAdapterConfigOptions(adapterType);
  return (
    <div data-testid="adapter-options">
      {isLoading ? "loading" : `${adapterType}:${configOptions?.length ?? "missing"}`}
    </div>
  );
}

function CatalogOptionsProbe({ adapterType }: { adapterType: string }) {
  const { adapters } = useAdapterCatalogSyncState();
  return adapters.some((adapter) => adapter.type === adapterType)
    ? <OptionsProbe adapterType={adapterType} />
    : null;
}

describe("useAdapterCatalogSyncState", () => {
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
    vi.unstubAllGlobals();
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

  it("synchronizes exactly the server-admitted local-agent catalog", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "codex",
        label: "Codex",
        modelsCount: 2,
        loaded: true,
        configOptions: [{
            id: "model",
            label: "Model",
            type: "select",
            values: [{ label: "Fast", value: "fast" }],
        }],
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: ["session/status", "session/set_config_option"],
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
      expect.objectContaining({ type: "codex" }),
    ]);
    expect(queryClient.getQueryData(queryKeys.adapters.all)).toEqual([
      expect.objectContaining({
        type: "codex",
        configOptions: [{
            id: "model",
            label: "Model",
            type: "select",
            values: [{ label: "Fast", value: "fast" }],
        }],
      }),
    ]);
  });

  it("does not synchronize a failed local readiness check into selectable UI adapters", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "visible-agent",
        label: "Visible agent",
        modelsCount: 0,
        loaded: true,
        configOptions: [],
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: ["session/status", "session/set_config_option"],
        },
      },
      {
        type: "failed-agent",
        label: "failed-agent",
        modelsCount: 0,
        loaded: false,
        diagnostic: {
          code: "acpx_probe_failed",
          message: "fixture local CLI is not authenticated",
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
      ).toBe("1:visible-agent");
      expect(listUIAdapters().map((adapter) => adapter.type)).toEqual(["visible-agent"]);
    });
    expect(queryClient.getQueryData(queryKeys.adapters.all)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "failed-agent", loaded: false }),
      ]),
    );
  });

  it("primes every option contract so switching adapters makes no extra request", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "alpha",
        label: "Alpha",
        modelsCount: 1,
        loaded: true,
        configOptions: [{
          id: "model",
          label: "Model",
          type: "select",
          values: [{ label: "Fast", value: "fast" }],
        }],
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: [],
        },
      },
      {
        type: "beta",
        label: "Beta",
        modelsCount: 1,
        loaded: true,
        configOptions: [],
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: [],
        },
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CatalogOptionsProbe adapterType="alpha" />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="adapter-options"]')?.textContent,
      ).toBe("alpha:1");
    });
    expect(fetchMock).not.toHaveBeenCalled();

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CatalogOptionsProbe adapterType="beta" />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="adapter-options"]')?.textContent,
      ).toBe("beta:0");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
