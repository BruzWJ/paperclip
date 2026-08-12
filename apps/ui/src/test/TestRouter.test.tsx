// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useParams } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouter } from "./TestRouter";

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
});

describe("TestRouter", () => {
  function UserIdProbe() {
    const { userId } = useParams({ strict: false });
    return <div data-testid="user-id">{userId}</div>;
  }

  it("mounts a company page for a canonical UUID parameter", async () => {
    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={["/11111111-1111-4111-8111-111111111111/artifacts"]}
        >
          <div>Company artifacts</div>
        </TestRouter>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Company artifacts");
    });
  });

  it("uses the native not-found boundary for a noncanonical company parameter", async () => {
    await act(async () => {
      root.render(
        <TestRouter initialEntries={["/company-1/artifacts"]}>
          <div>Company artifacts</div>
        </TestRouter>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="test-router-not-found"]'),
      ).not.toBeNull();
    });
    expect(container.textContent).not.toContain("Company artifacts");
  });

  it("rejects a percent-encoded alias before TanStack decodes the company parameter", async () => {
    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[
            "/%3111111111-1111-4111-8111-111111111111/artifacts",
          ]}
        >
          <div>Company artifacts</div>
        </TestRouter>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="test-router-not-found"]'),
      ).not.toBeNull();
    });
    expect(container.textContent).not.toContain("Company artifacts");
  });

  it("rejects a percent-encoded fragment alias before TanStack decodes it", async () => {
    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[
            "/11111111-1111-4111-8111-111111111111/artifacts#document-%70lan",
          ]}
        >
          <div>Company artifacts</div>
        </TestRouter>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="test-router-not-found"]'),
      ).not.toBeNull();
    });
    expect(container.textContent).not.toContain("Company artifacts");
  });

  it("rejects a percent-encoded search alias before TanStack decodes it", async () => {
    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[
            "/11111111-1111-4111-8111-111111111111/artifacts?kind=%61ll",
          ]}
        >
          <div>Company artifacts</div>
        </TestRouter>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="test-router-not-found"]'),
      ).not.toBeNull();
    });
    expect(container.textContent).not.toContain("Company artifacts");
  });

  it("preserves an opaque stored user ID without applying a UUID or slug transform", async () => {
    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[
            "/11111111-1111-4111-8111-111111111111/u/auth0%7CBoard.User%40example.test",
          ]}
        >
          <UserIdProbe />
        </TestRouter>,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="user-id"]')?.textContent,
      ).toBe("auth0|Board.User@example.test");
    });
  });
});
