// @vitest-environment jsdom

import type { DocumentAnnotationThreadWithComments, TaskDocument } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import {
  DocumentAnnotationsCountChip,
  TaskDocumentAnnotations,
  type TaskDocumentAnnotationsProps,
} from "./-TaskDocumentAnnotations";

export const TASK_ID = "11111111-1111-4111-8111-111111111111";
export const DEEP_LINK_THREAD_ID = "22222222-2222-4222-8222-222222222222";

const mockAnnotationsApi = vi.hoisted(() => {
  const api = {
    list: vi.fn(),
    create: vi.fn(),
    addComment: vi.fn(),
    updateStatus: vi.fn(),
  };
  return api;
});

const mockPendingAnchor = vi.hoisted(() => ({
  selector: {
    quote: { exact: "should keep the editor", prefix: "We ", suffix: "." },
    position: {
      normalizedStart: 10,
      normalizedEnd: 32,
      markdownStart: 10,
      markdownEnd: 32,
    },
  },
  selectedText: "should keep the editor",
}));

vi.mock("@/api/document-annotations", () => ({
  documentAnnotationsApi: mockAnnotationsApi,
}));

vi.mock("../-markdown/-MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-slot="sheet">{children}</div> : null,
  SheetContent: ({
    children,
    className,
    side,
  }: {
    children: React.ReactNode;
    className?: string;
    side?: string;
  }) => (
    <div data-slot="sheet-content" data-side={side} className={className}>
      {children}
    </div>
  ),
  SheetTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-slot="sheet-title" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("./-DocumentAnnotationLayer", () => ({
  DocumentAnnotationLayer: (props: {
    newCommentDisabled?: boolean;
    onPendingAnchorChange: (anchor: typeof mockPendingAnchor | null) => void;
    onRequestComment: (anchor: typeof mockPendingAnchor) => void;
  }) => (
    <>
      <button
        type="button"
        data-testid="mock-annotation-selection"
        disabled={props.newCommentDisabled}
        onClick={() => {
          props.onPendingAnchorChange(mockPendingAnchor);
          props.onRequestComment(mockPendingAnchor);
          props.onPendingAnchorChange(null);
        }}
      >
        Mock selection
      </button>
      <button
        type="button"
        data-testid="mock-annotation-selection-only"
        disabled={props.newCommentDisabled}
        onClick={() => {
          props.onPendingAnchorChange(mockPendingAnchor);
        }}
      >
        Mock captured selection
      </button>
    </>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function flush() {
  await act(() => {});
}

export function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export function dispatchSubmitShortcut(textarea: HTMLTextAreaElement) {
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
    }),
  );
}

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function makeDoc(overrides: Partial<TaskDocument> = {}): TaskDocument {
  return {
    id: "doc-1",
    companyId: "co-1",
    taskId: TASK_ID,
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "# Plan\n\nWe should keep the editor.",
    latestRevisionId: "rev-4",
    latestRevisionNumber: 4,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:01:00Z"),
    ...overrides,
  };
}

export function makeThread(
  overrides: Partial<DocumentAnnotationThreadWithComments> = {},
): DocumentAnnotationThreadWithComments {
  const id = overrides.id ?? "thread-1";
  return {
    id,
    companyId: "co-1",
    taskId: TASK_ID,
    documentId: "doc-1",
    documentKey: "plan",
    status: "open",
    anchorState: "active",
    anchorConfidence: "exact",
    originalRevisionId: "rev-4",
    originalRevisionNumber: 4,
    currentRevisionId: "rev-4",
    currentRevisionNumber: 4,
    selectedText: "should keep the editor",
    prefixText: "We ",
    suffixText: ".",
    normalizedStart: 0,
    normalizedEnd: 22,
    markdownStart: 0,
    markdownEnd: 22,
    anchorSelector: {
      quote: { exact: "should keep the editor", prefix: "We ", suffix: "." },
      position: {
        normalizedStart: 0,
        normalizedEnd: 22,
        markdownStart: 0,
        markdownEnd: 22,
      },
    },
    createdByAgentId: null,
    createdByUserId: "user-1",
    resolvedByAgentId: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date("2026-04-01T00:01:00Z"),
    updatedAt: new Date("2026-04-01T00:02:00Z"),
    comments: [
      {
        id: "comment-1",
        companyId: "co-1",
        threadId: id,
        taskId: TASK_ID,
        documentId: "doc-1",
        body: "Please clarify this assumption.",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "user-1",
        createdByRunId: null,
        createdAt: new Date("2026-04-01T00:01:00Z"),
        updatedAt: new Date("2026-04-01T00:01:00Z"),
      },
    ],
    ...overrides,
  };
}

export function Harness({
  doc,
  draftDirty = false,
  draftConflicted = false,
  historicalPreview = false,
  locationHash = "",
  initialPanelOpen = false,
  agentMap,
  userProfileMap,
}: {
  doc: TaskDocument;
  draftDirty?: boolean;
  draftConflicted?: boolean;
  historicalPreview?: boolean;
  locationHash?: string;
  initialPanelOpen?: boolean;
  agentMap?: TaskDocumentAnnotationsProps["agentMap"];
  userProfileMap?: TaskDocumentAnnotationsProps["userProfileMap"];
}) {
  const [open, setOpen] = useState(initialPanelOpen);
  const target = {
    kind: "task" as const,
    taskId: TASK_ID,
    documentKey: doc.key,
  };
  return (
    <>
      <DocumentAnnotationsCountChip
        target={target}
        panelOpen={open}
        onToggle={() => setOpen((current) => !current)}
      />
      <TaskDocumentAnnotations
        target={target}
        doc={doc}
        bodyMarkdown={doc.body}
        draftDirty={draftDirty}
        draftConflicted={draftConflicted}
        historicalPreview={historicalPreview}
        locationHash={locationHash}
        panelOpen={open}
        onPanelOpenChange={setOpen}
        agentMap={agentMap}
        userProfileMap={userProfileMap}
      >
        <p>Body content</p>
      </TaskDocumentAnnotations>
    </>
  );
}

Harness.render = async (
  container: HTMLElement,
  props: Partial<Parameters<typeof Harness>[0]> = {},
  inMainContent = false,
) => {
  const content = <Harness {...props} doc={props.doc ?? makeDoc()} />;
  await act(() =>
    createRoot(container).render(
      <QueryClientProvider client={makeQueryClient()}>
        {inMainContent ? <main id="main-content">{content}</main> : content}
      </QueryClientProvider>,
    ),
  );
  await flush();
  await flush();
};

export function useMockAnnotationsApiTestState() {
  return mockAnnotationsApi;
}

export function useMockPendingAnchorTestState() {
  return mockPendingAnchor;
}
