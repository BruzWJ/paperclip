// @vitest-environment jsdom

import type { Task } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTask } from "@/test-utils/task";
import { TaskStatusUpdateDialog, type StatusRecipientOption } from "./-TaskStatusUpdateDialog";
import { taskCreatorStatusRecipientOption } from "./-TaskPropertiesView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent) globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};

const recipients: readonly StatusRecipientOption[] = [
  {
    value: "owner",
    label: "Task owner · Board/user (unavailable)",
    disabled: true,
  },
  { value: "creator", label: "Task creator · Planning agent" },
];

function task(lifecycleStatus: Task["lifecycleStatus"]) {
  return { lifecycleStatus };
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
}

function button(label: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;
}

function controlForLabel<T extends HTMLElement>(text: string): T {
  const label = Array.from(document.querySelectorAll<HTMLLabelElement>("label")).find((candidate) =>
    candidate.textContent?.startsWith(text),
  )!;
  return document.getElementById(label.htmlFor) as T;
}

async function chooseStatus(label: string) {
  await click(controlForLabel<HTMLElement>("Status"));
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;
  await click(option);
}

async function enterMessage(value: string) {
  const textarea = controlForLabel<HTMLTextAreaElement>("Message");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("TaskStatusUpdateDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("does not alias an agent-owned parent as a Board-created task's creator", () => {
    const boardCreatedChild = createTestTask({
      parentId: "parent-task",
      creatorKind: "user/board",
      ancestors: [
        {
          id: "parent-task",
          taskNumber: 1,
          identifier: "PAP-1",
          title: "Parent",
          request: "Parent request",
          boardPresentationStatus: "in_progress",
          priority: "medium",
          ownerAgentId: "agent-parent-owner",
          ownerUserId: null,
          projectId: null,
          goalId: null,
          project: null,
          goal: null,
        },
      ],
    });

    expect(taskCreatorStatusRecipientOption(boardCreatedChild)).toEqual({
      value: "creator",
      label: "Task creator · unavailable",
      disabled: true,
    });
  });

  it("enables the immutable agent-execution creator without inventing an agent identity", () => {
    const agentCreatedChild = createTestTask({
      parentId: "parent-task",
      creatorKind: "agent-execution",
      creatorAuthorityId: "creator-execution-authority",
    });

    expect(taskCreatorStatusRecipientOption(agentCreatedChild)).toEqual({
      value: "creator",
      label: "Task creator · agent",
      disabled: false,
    });
  });

  it.each(["plugin", "routine", "system"] as const)(
    "keeps a %s creator unavailable as a status recipient",
    (creatorKind) => {
      expect(taskCreatorStatusRecipientOption(createTestTask({ creatorKind }))).toMatchObject({
        value: "creator",
        label: "Task creator · unavailable",
        disabled: true,
      });
    },
  );

  it("submits one explicit update and preserves its retry key", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response was lost"))
      .mockResolvedValueOnce(undefined);
    act(() => {
      root.render(
        <TaskStatusUpdateDialog
          task={task("open")}
          recipients={recipients}
          pending={false}
          onSubmit={onSubmit}
        />,
      );
    });

    await click(button("Update"));
    await chooseStatus("Blocked");
    await enterMessage("Waiting on customer input.");
    await click(button("Update status"));
    await click(button("Update status"));

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      status: "blocked",
      message: "Waiting on customer input.",
      recipient: "creator",
      idempotencyKey: expect.any(String),
    });
    expect(onSubmit.mock.calls[1]?.[0].idempotencyKey).toBe(onSubmit.mock.calls[0]?.[0].idempotencyKey);
  });
});
