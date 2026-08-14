// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouter } from "@/test/TestRouter";
import { LiveUpdatesProvider } from "./LiveUpdatesProvider";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));

describe("LiveUpdatesProvider route scope", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockAuthApi.getSession.mockResolvedValue(null);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("renders on the root route without requiring an active company match", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TestRouter initialEntries={["/"]} queryClient={queryClient}>
            <LiveUpdatesProvider>
              <div>Signed-out root content</div>
            </LiveUpdatesProvider>
          </TestRouter>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Signed-out root content");
    });
    expect(mockAuthApi.getSession).toHaveBeenCalledTimes(1);
  });
});
