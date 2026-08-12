// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { TestRouter } from "@/test/TestRouter";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const ENTITY_ROUTES = [
  {
    entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    path: (entityId: string) =>
      `/${COMPANY_ID}/agents/${entityId}/configuration`,
  },
  {
    entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    path: (entityId: string) => `/${COMPANY_ID}/projects/${entityId}/budget`,
  },
  {
    entityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    path: (entityId: string) => `/${COMPANY_ID}/approvals/${entityId}`,
  },
  {
    entityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    path: (entityId: string) => `/${COMPANY_ID}/goals/${entityId}`,
  },
  {
    entityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    path: (entityId: string) => `/${COMPANY_ID}/routines/${entityId}/history`,
  },
] as const;

let container: HTMLDivElement;
let root: Root;

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("company-owned entity route loaders", () => {
  it.each(ENTITY_ROUTES)(
    "rejects a resource owned by another company at $path",
    async ({ entityId, path }) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ id: entityId, companyId: OTHER_COMPANY_ID }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          ),
      );

      await act(async () => {
        root.render(
          <TestRouter
            initialEntries={[path(entityId)]}
            queryClient={createQueryClient()}
          >
            <div>Cross-company entity</div>
          </TestRouter>,
        );
      });

      await vi.waitFor(() => {
        expect(
          container.querySelector('[data-testid="test-router-not-found"]'),
        ).not.toBeNull();
      });
      expect(container.textContent).not.toContain("Cross-company entity");
    },
  );

  it("renders and seeds the canonical query key for an exact entity", async () => {
    const agentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const agent = { id: agentId, companyId: COMPANY_ID, name: "Exact agent" };
    const queryClient = createQueryClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(agent), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[`/${COMPANY_ID}/agents/${agentId}`]}
          queryClient={queryClient}
        >
          <div>Exact company entity</div>
        </TestRouter>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Exact company entity");
    });
    expect(queryClient.getQueryData(queryKeys.agents.detail(agentId))).toEqual(
      agent,
    );
  });

  it("maps an entity API 404 to the native not-found boundary", async () => {
    const goalId = "99999999-9999-4999-8999-999999999999";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Goal not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[`/${COMPANY_ID}/goals/${goalId}`]}
          queryClient={createQueryClient()}
        >
          <div>Missing goal</div>
        </TestRouter>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="test-router-not-found"]'),
      ).not.toBeNull();
    });
    expect(container.textContent).not.toContain("Missing goal");
  });
});
