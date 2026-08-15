// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarServerInfo } from "./-SidebarServerInfo";

const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getGeneral: vi.fn() }));

vi.mock("@/api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

async function flushReact() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("SidebarServerInfo", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <SidebarServerInfo />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHealthApi.get.mockReset();
    mockInstanceSettingsApi.getGeneral.mockReset();
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it("renders nothing while the General setting is disabled", async () => {
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      enableServerInfoDebugView: false,
    });

    await render();

    expect(container.textContent).toBe("");
    expect(mockHealthApi.get).not.toHaveBeenCalled();
  });

  it("shows restart, commit, and checkout details when enabled", async () => {
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      enableServerInfoDebugView: true,
    });
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      devServer: {
        enabled: true,
        restartRequired: false,
        reason: null,
        lastChangedAt: null,
        changedPathCount: 0,
        changedPathsSample: [],
        autoRestartEnabled: false,
        activeRunCount: 0,
        waitingForIdle: false,
        lastRestartAt: "2026-08-07T01:15:00.000Z",
      },
      serverInfo: {
        processStartedAt: "2026-08-07T00:00:00.000Z",
        git: {
          available: true,
          fullSha: "abcdef1234567890abcdef1234567890abcdef12",
          shortSha: "abcdef1",
          branchName: "main",
          subject: "Add General server controls",
          committedAt: "2026-08-06T23:00:00.000Z",
          localChanges: {
            available: true,
            hasLocalChanges: true,
            stagedFileCount: 3,
            unstagedFileCount: 2,
            untrackedFileCount: 1,
          },
        },
      },
    });

    await render();

    expect(container.textContent).toContain("Last restarted");
    expect(container.textContent).toContain("Running commit");
    expect(container.textContent).toContain("abcdef1");
    expect(container.textContent).toContain(
      "Local changes present (3 staged, 2 unstaged, 1 untracked)",
    );
    expect(
      container.querySelector('time[dateTime="2026-08-07T01:15:00.000Z"]'),
    ).not.toBeNull();
  });
});
