// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from ".";
import { getRouteComponent } from "@/test/route-component";

const InstanceGeneralSettings = getRouteComponent(Route);

const mockAuthApi = vi.hoisted(() => ({ signOut: vi.fn() }));
const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));
vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

describe("InstanceGeneralSettings", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function toggle(label: string) {
    const control = container.querySelector<HTMLButtonElement>(
      `[aria-label="${label}"]`,
    );
    expect(control).not.toBeNull();
    return control!;
  }

  async function clickToggle(label: string) {
    await act(async () => {
      toggle(label).click();
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    });
  }

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <InstanceGeneralSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const enabledMeta = document.createElement("meta");
    enabledMeta.name = "paperclip-worktree-enabled";
    enabledMeta.content = "true";
    document.head.appendChild(enabledMeta);
    const instanceMeta = document.createElement("meta");
    instanceMeta.name = "paperclip-instance-id";
    instanceMeta.content = "worktree-instance-1";
    document.head.appendChild(instanceMeta);

    mockAuthApi.signOut.mockReset();
    mockHealthApi.get.mockReset();
    mockInstanceSettingsApi.getGeneral.mockReset();
    mockInstanceSettingsApi.updateGeneral.mockReset();

    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
    });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
    });
    mockInstanceSettingsApi.updateGeneral.mockImplementation(async (patch) => ({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      enableServerInfoDebugView: false,
      autoRestartDevServerWhenIdle: false,
      enableWorktreeRunExecution: false,
      worktreeRunExecutionActivatedAt: null,
      worktreeRunExecutionActivationInstanceId: null,
      ...patch,
    }));
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    document.body.replaceChildren();
    document.head
      .querySelectorAll(
        'meta[name^="paperclip-worktree-"], meta[name="paperclip-instance-id"]',
      )
      .forEach((node) => node.remove());
    vi.clearAllMocks();
  });

  it("renders the General controls with their intended defaults", async () => {
    await render();

    expect(container.textContent).toContain("Reconcile workspace branches");
    expect(container.textContent).toContain("Repair dirty workspaces");
    expect(container.textContent).toContain("Server Info debug view");
    expect(container.textContent).toContain(
      "Auto-restart dev server when idle",
    );
    expect(container.textContent).toContain(
      "Run scheduled tasks in this worktree",
    );

    expect(
      toggle("Toggle workspace branch reconciliation").getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      toggle("Toggle dirty workspace repair").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      toggle("Toggle Server Info debug view").getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      toggle("Toggle automatic idle dev-server restart").getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    expect(
      toggle("Toggle worktree scheduled task execution").getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
  });

  it("persists changes to each workspace and server General control", async () => {
    await render();

    await clickToggle("Toggle workspace branch reconciliation");
    await clickToggle("Toggle dirty workspace repair");
    await clickToggle("Toggle Server Info debug view");
    await clickToggle("Toggle automatic idle dev-server restart");
    await clickToggle("Toggle worktree scheduled task execution");

    expect(
      mockInstanceSettingsApi.updateGeneral.mock.calls.map(([patch]) => patch),
    ).toEqual([
      { enableWorkspaceBranchReconcileForward: false },
      { enableWorkspaceDirtyQuarantineRepair: false },
      { enableServerInfoDebugView: true },
      { autoRestartDevServerWhenIdle: true },
      { enableWorktreeRunExecution: true },
    ]);
  });

  it("does not offer the worktree-only control in a normal instance", async () => {
    document.head
      .querySelectorAll(
        'meta[name^="paperclip-worktree-"], meta[name="paperclip-instance-id"]',
      )
      .forEach((node) => node.remove());

    await render();

    expect(container.textContent).not.toContain(
      "Run scheduled tasks in this worktree",
    );
    expect(
      container.querySelector(
        '[aria-label="Toggle worktree scheduled task execution"]',
      ),
    ).toBeNull();
  });
});
