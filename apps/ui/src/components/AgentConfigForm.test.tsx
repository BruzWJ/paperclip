// @vitest-environment jsdom

import { act, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { syncServerAdapters } from "@/adapters/registry";
import { AgentConfigForm } from "./AgentConfigForm";

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
  testConfiguration: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: null }),
}));
vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));
vi.mock("../api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));
vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => (
    <textarea readOnly value={value} />
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const agent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Test Agent",
  urlKey: "test-agent",
  title: null,
  icon: null,
  status: "active",
  reportsTo: null,
  capabilities: null,
  adapterType: "missing-local-agent",
  adapterConfig: {},
  currentAdapterConfigRevisionId: null,
  runtimeConfig: {},
  pauseReason: null,
  pausedAt: null,
  instruction: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} as unknown as Agent;

type HarnessState = {
  dirty: boolean;
  saveAction: (() => void) | null;
  cancelAction: (() => void) | null;
};

let harnessState: HarnessState;
let queryClient: QueryClient;

/**
 * Mirrors the ConfigurationTab wiring in AgentDetail: the registered save and
 * cancel actions live in React state, so an action re-registered on every
 * render (fresh function identity) re-renders the harness, which re-runs the
 * form's registration effect — the "maximum update depth exceeded" loop this
 * regression test guards.
 */
function Harness({
  onSave,
}: {
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [saveAction, setSaveAction] = useState<(() => void) | null>(null);
  const [cancelAction, setCancelAction] = useState<(() => void) | null>(null);
  const handleSaveActionChange = useCallback((action: (() => void) | null) => {
    setSaveAction(() => action);
  }, []);
  const handleCancelActionChange = useCallback((action: (() => void) | null) => {
    setCancelAction(() => action);
  }, []);
  harnessState = { dirty, saveAction, cancelAction };
  return (
    <AgentConfigForm
      mode="edit"
      agent={agent}
      onSave={onSave}
      onDirtyChange={setDirty}
      onSaveActionChange={handleSaveActionChange}
      onCancelActionChange={handleCancelActionChange}
      hideInlineSave
      sectionLayout="cards"
    />
  );
}

describe("AgentConfigForm (edit mode)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    syncServerAdapters([]);
    mockAdaptersApi.list.mockResolvedValue([]);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    syncServerAdapters([]);
    vi.clearAllMocks();
  });

  function render(onSave: (patch: Record<string, unknown>) => void = () => undefined) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Harness onSave={onSave} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("settles after mount instead of looping action registration", () => {
    render();

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Agent name"]',
    );
    expect(nameInput).not.toBeNull();
    expect(nameInput!.value).toBe("Test Agent");
    expect(harnessState!.dirty).toBe(false);
    expect(typeof harnessState!.saveAction).toBe("function");
    expect(typeof harnessState!.cancelAction).toBe("function");
  });

  it("registered save action delegates to the latest draft", () => {
    const onSave = vi.fn();
    render(onSave);

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Agent name"]',
    )!;
    act(() => setInputValue(nameInput, "Renamed Agent"));

    expect(harnessState!.dirty).toBe(true);

    // The action registered on mount must invoke the current handlers, not a
    // stale closure from the first render.
    const mountedSaveAction = harnessState!.saveAction!;
    act(() => {
      void mountedSaveAction();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed Agent" }),
    );
  });

  it("keeps the registered action identity stable across dirty transitions", () => {
    render();
    const mountedSaveAction = harnessState!.saveAction;

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Agent name"]',
    )!;
    act(() => setInputValue(nameInput, "Renamed Agent"));

    expect(harnessState!.saveAction).toBe(mountedSaveAction);
  });

  it("uses an adapter that arrives after the form's first render", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "missing-local-agent",
        label: "Available local agent",
        source: "acpx",
        modelsCount: 0,
        loaded: true,
        registryName: "missing-local-agent",
        configSchema: { fields: [] },
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: [],
          supportsModelProfiles: false,
        },
      },
    ]);

    render();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).not.toContain(
          "This adapter is not available from the local agent catalog.",
        );
      });
    });
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Test Agent",
      ),
    ).toBe(true);
  });
});
