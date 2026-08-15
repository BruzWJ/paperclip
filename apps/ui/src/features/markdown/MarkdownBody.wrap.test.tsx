// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => "11111111-1111-4111-8111-111111111111",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: {
    get: vi.fn(),
  },
}));

describe("MarkdownBody code block wrapping", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it("toggles fenced code blocks between horizontal scroll and wrapped lines", () => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MarkdownBody>{"```text\nlong line that can wrap when requested\n```"}</MarkdownBody>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });

    const pre = container.querySelector("pre");
    const actions = container.querySelector<HTMLDivElement>(".paperclip-markdown-codeblock-actions");
    const wrapButton = container.querySelector<HTMLButtonElement>(".paperclip-markdown-codeblock-wrap");

    expect(pre).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(wrapButton).not.toBeNull();
    expect(actions?.getAttribute("data-active")).toBeNull();
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");
    const codeBlock = container.querySelector<HTMLElement>(".paperclip-markdown-codeblock");
    expect(codeBlock?.getAttribute("data-wrap-lines")).toBeNull();

    flushSync(() => {
      wrapButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Unwrap lines");
    expect(actions?.getAttribute("data-active")).toBe("true");
    expect(codeBlock?.getAttribute("data-wrap-lines")).toBe("true");

    flushSync(() => {
      wrapButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
    expect(wrapButton?.getAttribute("aria-label")).toBe("Wrap lines");
    expect(actions?.getAttribute("data-active")).toBeNull();
    expect(codeBlock?.getAttribute("data-wrap-lines")).toBeNull();
  });

  it("fails closed for unknown same-origin links while preserving external, file, and hash anchors", () => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MarkdownBody>
              {
                "[Internal](/11111111-1111-4111-8111-111111111111/dashboard) [External](https://example.com/docs) [File](/api/assets/asset-1/content) [Section](#details)"
              }
            </MarkdownBody>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector('a[href="/11111111-1111-4111-8111-111111111111/dashboard"]')).toBeNull();
    expect(container.textContent).toContain("Internal");
    expect(container.querySelector('a[href="https://example.com/docs"]')?.getAttribute("target")).toBe(
      "_blank",
    );
    expect(container.querySelector('a[href="/api/assets/asset-1/content"]')).not.toBeNull();
    expect(container.querySelector('a[href="#details"]')).not.toBeNull();
  });
});
