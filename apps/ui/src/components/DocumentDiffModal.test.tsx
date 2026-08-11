// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentRevision } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (
    open ? <div>{children}</div> : null
  ),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

import { DocumentDiffModal } from "./DocumentDiffModal";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function createRevision(overrides: Partial<DocumentRevision> = {}): DocumentRevision {
  return {
    id: "revision-1",
    companyId: "company-1",
    documentId: "document-1",
    taskId: "task-1",
    key: "plan",
    revisionNumber: 1,
    title: "Plan",
    format: "markdown",
    body: "First saved plan",
    changeSummary: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-08-03T12:00:00.000Z"),
    ...overrides,
  };
}

describe("DocumentDiffModal", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    cleanup.splice(0).forEach((dispose) => dispose());
    document.body.innerHTML = "";
  });

  async function render(revisions: DocumentRevision[]) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const revisionsQueryFn = vi.fn().mockResolvedValue(revisions);

    cleanup.push(() => {
      flushSync(() => root.unmount());
      queryClient.clear();
      container.remove();
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DocumentDiffModal
            documentKey="plan"
            latestRevisionNumber={revisions.length}
            open
            onOpenChange={() => {}}
            revisionsQueryKey={["document-diff-test", revisions.length]}
            revisionsQueryFn={revisionsQueryFn}
          />
        </QueryClientProvider>,
      );
    });
    await flush();

    return { container, revisionsQueryFn };
  }

  it("explains when no saved revisions are available", async () => {
    const { container, revisionsQueryFn } = await render([]);

    expect(revisionsQueryFn).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="document-diff-empty"]')?.textContent)
      .toContain("No revisions are available for this document.");
    expect(container.textContent).toContain("Save changes to create the first revision");
  });

  it("explains when there is only one revision to compare", async () => {
    const { container } = await render([createRevision()]);

    expect(container.querySelector('[data-testid="document-diff-empty"]')?.textContent)
      .toContain("A second revision is needed to compare changes.");
    expect(container.textContent).toContain("Save another revision");
  });
});
