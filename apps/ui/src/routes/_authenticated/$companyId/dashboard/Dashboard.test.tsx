// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from ".";
import { TestRouter } from "@/test/TestRouter";

const mocks = vi.hoisted(() => ({
  openNewAgent: vi.fn(),
  openOnboarding: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const root = queryKey[0];
    if (root === "agents") return { data: [] };
    if (root === "dashboard") {
      return {
        data: undefined,
        isLoading: false,
        error: null,
        dataUpdatedAt: 0,
      };
    }
    if (root === "activity") return { data: [], dataUpdatedAt: 0 };
    if (root === "tasks" || root === "projects") return { data: [] };
    return { data: undefined };
  },
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({
    openNewAgent: mocks.openNewAgent,
    openOnboarding: mocks.openOnboarding,
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }),
}));

vi.mock("@/components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => null,
}));

describe("Dashboard empty-agent action", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("opens ordinary agent creation instead of onboarding", async () => {
    await act(async () =>
      root.render(
        <TestRouter
          initialEntries={["/11111111-1111-4111-8111-111111111111/dashboard"]}
        >
          <Dashboard />
        </TestRouter>,
      ),
    );

    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Create one here",
    );
    expect(button).toBeDefined();

    await act(async () => button?.click());

    expect(mocks.openNewAgent).toHaveBeenCalledOnce();
    expect(mocks.openOnboarding).not.toHaveBeenCalled();
  });
});
