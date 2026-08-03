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
        "cancel",
        "contractVersion",
        "protocolVersion",
        "resume",
        "sessionConfig",
        "sessionScopedMcpReplacement",
        "supportsModelProfiles",
      ],
      capabilities: {
        cancel: false,
        contractVersion: "acp-subprocess/v1",
        protocolVersion: 1,
        resume: false,
        sessionConfig: false,
        sessionScopedMcpReplacement: false,
        supportsModelProfiles: false,
      },
    });
  });

  it("uses the exact declarative contract supplied for Codex", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "codex",
        label: "Codex",
        modelsCount: 2,
        loaded: true,
        registryName: "codex",
        frontendPackage: "@agentclientprotocol/codex-acp",
        frontendVersion: "1.1.7",
        frontendDigest: "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a",
        capabilities: {
          cancel: true,
          contractVersion: "acp-subprocess/v1",
          protocolVersion: 1,
          resume: true,
          sessionConfig: true,
          sessionScopedMcpReplacement: true,
          supportsModelProfiles: false,
        },
      },
    ]);

    render("codex");

    await vi.waitFor(() => {
      expect(renderedContract()).toEqual({
        keys: [
          "cancel",
          "contractVersion",
          "protocolVersion",
          "resume",
          "sessionConfig",
          "sessionScopedMcpReplacement",
          "supportsModelProfiles",
        ],
        capabilities: {
          cancel: true,
          contractVersion: "acp-subprocess/v1",
          protocolVersion: 1,
          resume: true,
          sessionConfig: true,
          sessionScopedMcpReplacement: true,
          supportsModelProfiles: false,
        },
      });
    });
  });
});
