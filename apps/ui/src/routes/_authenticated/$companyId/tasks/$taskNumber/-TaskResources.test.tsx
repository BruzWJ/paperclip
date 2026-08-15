// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Task, TaskAttachment, TaskWorkProduct } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/routes/_authenticated/$companyId/-TaskLinkQuicklook", () => ({
  TaskLinkQuicklook: ({ children, title }: { children?: ReactNode; title?: string }) => (
    <a href="/task" title={title}>
      {children}
    </a>
  ),
}));

import { TaskResources, type TaskResourcesProps } from "./-TaskResources";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const OUTPUT_ID = "44444444-4444-4444-8444-444444444444";
const OUTPUT_ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";
const DOCUMENT_ID = "66666666-6666-4666-8666-666666666666";

const task = {
  id: TASK_ID,
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Parent task",
  documentSummaries: [
    {
      id: DOCUMENT_ID,
      companyId: "company-1",
      taskId: TASK_ID,
      key: "plan",
      title: null,
      format: "markdown",
      latestRevisionId: "revision-1",
      latestRevisionNumber: 2,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
      lockedAt: null,
      lockedByAgentId: null,
      lockedByUserId: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    },
  ],
} as Task;

const child = {
  id: CHILD_ID,
  companyId: "company-1",
  parentId: TASK_ID,
  taskNumber: 2,
  identifier: "PAP-2",
  title: "Compact child",
  boardPresentationStatus: "todo",
} as Task;

const attachment = {
  id: ATTACHMENT_ID,
  companyId: "company-1",
  taskId: TASK_ID,
  taskCommentId: null,
  assetId: "asset-1",
  provider: "local_disk",
  objectKey: "tasks/brief.pdf",
  contentType: "application/pdf",
  byteSize: 2048,
  sha256: "abc",
  originalFilename: "brief.pdf",
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  contentPath: "/api/assets/asset-1/content",
  openPath: "/api/assets/asset-1/open",
  downloadPath: "/api/assets/asset-1/download",
} satisfies TaskAttachment;

const output = {
  id: OUTPUT_ID,
  companyId: "company-1",
  projectId: null,
  taskId: TASK_ID,
  type: "artifact",
  provider: "paperclip",
  externalId: null,
  title: "demo.png",
  url: null,
  status: "active",
  reviewState: "none",
  isPrimary: true,
  healthStatus: "healthy",
  summary: null,
  metadata: {
    attachmentId: OUTPUT_ATTACHMENT_ID,
    contentType: "image/png",
    byteSize: 4096,
    contentPath: "/api/assets/output/content",
    openPath: "/api/assets/output/open",
    downloadPath: "/api/assets/output/download",
    originalFilename: "demo.png",
  },
  createdByRunId: null,
  createdAt: new Date("2026-08-03T00:00:00.000Z"),
  updatedAt: new Date("2026-08-03T00:00:00.000Z"),
} satisfies TaskWorkProduct;

function props(overrides: Partial<TaskResourcesProps> = {}): TaskResourcesProps {
  return {
    task,
    childTasks: [child],
    childTasksLoading: false,
    liveTaskIds: new Set(),
    mutedChildTaskIds: new Set(),
    childPauseBadgeById: new Map(),
    onAddSubTask: vi.fn(),
    attachments: [attachment],
    attachmentsLoading: false,
    attachmentError: null,
    attachmentUploadPending: false,
    onUploadFiles: vi.fn(),
    attachmentDeletePending: false,
    onDeleteAttachment: vi.fn(),
    onPreviewAttachment: vi.fn(),
    workProducts: [output],
    onPreviewOutput: vi.fn(),
    onOpenDocuments: vi.fn(),
    ...overrides,
  };
}

describe("TaskResources", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("uses compact loading rows without mounting task-list search or filter controls", () => {
    act(() => root.render(<TaskResources {...props({ childTasks: [], childTasksLoading: true })} />));

    expect(container.textContent).toContain("Loading sub-tasks.");
    expect(container.textContent).not.toContain("Search");
    expect(container.textContent).not.toContain("Filter");
    expect(container.textContent).not.toContain("New Sub-task");
    expect(container.querySelector('button[aria-label="Create sub-task"]')).not.toBeNull();
  });

  it("keeps attachment and output deep-link anchors in the compact rows", () => {
    act(() => root.render(<TaskResources {...props()} />));

    expect(container.querySelector(`#attachment-${ATTACHMENT_ID}`)).not.toBeNull();
    expect(container.querySelector(`#work-product-${OUTPUT_ID}`)).not.toBeNull();
    expect(container.textContent).toContain("brief.pdf");
    expect(container.textContent).toContain("demo.png");
  });

  it("uploads through the compact file action and opens documents on demand", () => {
    const onUploadFiles = vi.fn();
    const onOpenDocuments = vi.fn();
    act(() => root.render(<TaskResources {...props({ onUploadFiles, onOpenDocuments })} />));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["# Plan"], "plan.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(onUploadFiles).toHaveBeenCalledWith([file]);

    const openWorkspace = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open document workspace"]',
    );
    act(() => openWorkspace?.click());
    expect(onOpenDocuments).toHaveBeenCalledTimes(1);
  });
});
