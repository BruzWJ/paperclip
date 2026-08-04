// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasesExperimentalGate } from "./CasesExperimentalGate";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={String(replace ?? false)} />
  ),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("CasesExperimentalGate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderGate() {
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <CasesExperimentalGate>
            <div data-testid="cases-content">Cases content</div>
          </CasesExperimentalGate>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("redirects to the dashboard when Cases are disabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableCases: false });
    await renderGate();

    const navigate = container.querySelector('[data-testid="navigate"]');
    expect(navigate?.getAttribute("data-to")).toBe("/dashboard");
    expect(navigate?.getAttribute("data-replace")).toBe("true");
    expect(container.querySelector('[data-testid="cases-content"]')).toBeNull();
  });

  it("renders Cases routes when the feature is enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableCases: true });
    await renderGate();

    expect(container.querySelector('[data-testid="cases-content"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="navigate"]')).toBeNull();
  });

  it("shows retryable guidance when feature settings cannot be loaded", async () => {
    mockInstanceSettingsApi.getExperimental.mockRejectedValue(new Error("network unavailable"));
    await renderGate();

    expect(container.textContent).toContain("Cases are unavailable");
    expect(container.textContent).toContain("could not check whether the Cases feature is enabled");
    expect(container.querySelector('a[href="/dashboard"]')?.textContent).toContain("Return to dashboard");
    expect(container.querySelector("button")?.textContent).toContain("Try again");
  });
});
