// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevRestartBanner } from "./DevRestartBanner";

const mockHealthApi = vi.hoisted(() => ({
  requestDevServerRestart: vi.fn(),
}));

vi.mock("../api/health", () => ({ healthApi: mockHealthApi }));

const baseStatus = {
  enabled: true as const,
  restartRequired: true,
  reason: "backend_changes" as const,
  lastChangedAt: "2026-03-20T12:00:00.000Z",
  changedPathCount: 1,
  changedPathsSample: ["apps/server/src/routes/health.ts"],
  autoRestartEnabled: false,
  activeRunCount: 0,
  waitingForIdle: false,
  lastRestartAt: "2026-03-20T11:30:00.000Z",
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => undefined);
  mockHealthApi.requestDevServerRestart.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  mockHealthApi.requestDevServerRestart.mockReset();
});

function render(status = baseStatus) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<DevRestartBanner devServer={status} />));
  return container;
}

describe("DevRestartBanner", () => {
  it("keeps manual restart reachable while automatic restart is disabled", async () => {
    const node = render();
    const button = [...node.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Restart now"),
    );

    expect(node.textContent).not.toContain("Auto-Restart On");
    expect(node.textContent).toContain("Restart after active work is safe to interrupt");

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(window.confirm).toHaveBeenCalledWith("Restart Paperclip now?");
    expect(mockHealthApi.requestDevServerRestart).toHaveBeenCalledTimes(1);
  });

  it("warns before interrupting a live run", async () => {
    const node = render({
      ...baseStatus,
      autoRestartEnabled: true,
      activeRunCount: 1,
      waitingForIdle: true,
    });
    const button = [...node.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Restart now"),
    );

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(window.confirm).toHaveBeenCalledWith(
      "Restart Paperclip now? This may interrupt 1 live run.",
    );
    expect(node.textContent).toContain("Waiting for 1 live run to finish");
  });
});
