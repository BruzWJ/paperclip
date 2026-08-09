// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAdapterCapabilities } from "./use-adapter-capabilities";

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/adapters")>()),
  adaptersApi: mockAdaptersApi,
}));

function Probe({ adapterType }: { adapterType: string }) {
  const capabilities = useAdapterCapabilities()(adapterType);
  return (
    <pre data-testid="capabilities">
      {JSON.stringify({
        keys: Object.keys(capabilities).sort(),
        capabilities,
      })}
    </pre>
  );
}

describe("useAdapterCapabilities", () => {
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
      defaultOptions: {
        queries: { retry: false },
      },
    });
    mockAdaptersApi.list.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  function render(adapterType: string) {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe adapterType={adapterType} />
        </QueryClientProvider>,
      );
    });
  }

  function renderedContract() {
    return JSON.parse(
      container.querySelector('[data-testid="capabilities"]')?.textContent
        ?? "{}",
    ) as {
      keys: string[];
      capabilities: Record<string, unknown>;
    };
  }

  it("fails closed before the server catalog is available", () => {
    render("codex");

    expect(renderedContract()).toEqual({
      keys: [
        "contractVersion",
        "runtimeControls",
        "supportsModelProfiles",
      ],
      capabilities: {
        contractVersion: "acpx-runtime/v1",
        runtimeControls: [],
        supportsModelProfiles: false,
      },
    });
  });

  it("uses the exact declarative contract supplied for Codex", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "codex",
        label: "Codex",
        source: "acpx",
        modelsCount: 2,
        loaded: true,
        registryName: "codex",
        configSchema: { fields: [] },
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: ["session/status", "session/set_config_option"],
          supportsModelProfiles: false,
        },
      },
    ]);

    render("codex");

    await vi.waitFor(() => {
      expect(renderedContract()).toEqual({
        keys: [
          "contractVersion",
          "runtimeControls",
          "supportsModelProfiles",
        ],
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: ["session/status", "session/set_config_option"],
          supportsModelProfiles: false,
        },
      });
    });
  });
});
