// @vitest-environment jsdom

import type { Routine, RoutineRevision, RoutineRevisionSnapshotV1 } from "@paperclipai/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { vi } from "vitest";

const mockRoutinesApi = vi.hoisted(() => ({
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
}));

vi.mock("@/api/routines", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/api/routines");
  return {
    ...actual,
    routinesApi: {
      ...((actual as { routinesApi?: Record<string, unknown> }).routinesApi ?? {}),
      ...mockRoutinesApi,
    },
  };
});

vi.mock("../../../../../../features/markdown/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: ComponentProps<"div">) => <>{children}</>,
  AlertDialogHeader: ({ children }: ComponentProps<"div">) => <>{children}</>,
  AlertDialogTitle: ({ children }: ComponentProps<"h2">) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: ComponentProps<"p">) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: ComponentProps<"div">) => <>{children}</>,
  AlertDialogCancel: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  AlertDialogAction: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", disabled, ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input aria-label="Text input" {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: ComponentProps<"div">) => <div data-testid="skeleton" {...props} />,
}));

export const toastSpy = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: toastSpy,
    success: toastSpy,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function snapshotV1(
  overrides?: Partial<RoutineRevisionSnapshotV1["routine"]>,
): RoutineRevisionSnapshotV1 {
  return {
    version: 1,
    routine: {
      id: "routine-1",
      companyId: "company-1",
      projectId: null,
      goalId: null,
      parentTaskId: null,
      responsibleUserId: null,
      title: "Daily standup digest",
      description: "Summarize standup notes",
      assigneeAgentId: null,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      env: null,
      ...overrides,
    },
    triggers: [],
  };
}

export function createRevision(overrides: Partial<RoutineRevision> = {}): RoutineRevision {
  return {
    id: overrides.id ?? "revision-1",
    companyId: "company-1",
    routineId: "routine-1",
    revisionNumber: overrides.revisionNumber ?? 1,
    title: "Daily standup digest",
    description: "Summarize standup notes",
    snapshot: overrides.snapshot ?? snapshotV1(),
    changeSummary: null,
    restoredFromRevisionId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdByRunId: null,
    createdAt: new Date("2026-05-01T12:00:00.000Z"),
    ...overrides,
  };
}

export function createRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    parentTaskId: null,
    responsibleUserId: null,
    title: "Daily standup digest",
    description: "Summarize standup notes",
    assigneeAgentId: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
    latestRevisionId: "revision-2",
    latestRevisionNumber: 2,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    lastTriggeredAt: null,
    lastEnqueuedAt: null,
    createdAt: new Date("2026-05-01T11:00:00.000Z"),
    updatedAt: new Date("2026-05-04T12:00:00.000Z"),
    ...overrides,
  };
}

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function useMockRoutinesApiTestState() {
  return mockRoutinesApi;
}
