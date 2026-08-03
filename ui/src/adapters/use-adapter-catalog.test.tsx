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

  it("synchronizes exactly the server-admitted ACP catalog", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "codex",
        label: "Codex",
        modelsCount: 2,
        loaded: true,
        registryName: "codex",
        frontendPackage: "@agentclientprotocol/codex-acp",
        frontendVersion: "1.1.7",
        frontendDigest:
          "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
        capabilities: {
          contractVersion: "acp-subprocess/v1",
          protocolVersion: 1,
          resume: true,
          cancel: true,
          sessionConfig: true,
          sessionScopedMcpReplacement: true,
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
    expect(listUIAdapters().map((adapter) => adapter.type)).toEqual(["codex"]);
  });
});
