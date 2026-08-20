// @vitest-environment jsdom

import { buildAgentMentionHref } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskChatComposerProps, TaskChatMentionTarget } from "./-TaskChatShared";
import { TaskChatComposer } from "./-TaskChatComposerView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const target: TaskChatMentionTarget = {
  targetAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  ownershipEpoch: 7,
  name: "Research agent",
  icon: "search",
};

let container: HTMLDivElement;
let root: Root;

function renderComposer(props: Partial<TaskChatComposerProps> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn(async () => undefined);
  act(() => {
    root.render(
      <TooltipProvider>
        <TaskChatComposer
          mentionTarget={target}
          mentionIsResponseOnly={false}
          onSubmit={onSubmit}
          {...props}
        />
      </TooltipProvider>,
    );
  });
  return onSubmit;
}

async function changeTextarea(value: string, cursor = value.length) {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task message"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(textarea, value);
    textarea.setSelectionRange(cursor, cursor);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  return textarea;
}

async function pressKey(textarea: HTMLTextAreaElement, key: string) {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
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
  container.remove();
  vi.unstubAllGlobals();
});

describe("TaskChatComposer agent mentions", () => {
  it("notifies the current owner only after the explicit toggle is selected", async () => {
    const onSubmit = renderComposer();
    const notifyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Notify Research agent"]',
    )!;

    expect(notifyButton.getAttribute("aria-pressed")).toBe("false");
    act(() => notifyButton.click());
    expect(notifyButton.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Research agent will receive your message.",
    );

    const textarea = await changeTextarea("Please share another update");
    await pressKey(textarea, "Enter");
    expect(onSubmit).toHaveBeenCalledWith(
      `[@Research agent](${buildAgentMentionHref(target.targetAgentId, target.icon)}) Please share another update`,
      { targetAgentId: target.targetAgentId, ownershipEpoch: target.ownershipEpoch },
      undefined,
    );
  });

  it("lets the board turn owner notification back off before sending", async () => {
    const onSubmit = renderComposer();
    const notifyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Notify Research agent"]',
    )!;

    act(() => notifyButton.click());
    act(() => notifyButton.click());
    expect(notifyButton.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[role="status"]')).toBeNull();

    const textarea = await changeTextarea("A note for the task history");
    await pressKey(textarea, "Enter");

    expect(onSubmit).toHaveBeenCalledWith("A note for the task history", undefined, undefined);
  });

  it("clears notification intent when the ownership epoch changes", async () => {
    const onSubmit = renderComposer();
    const notifyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Notify Research agent"]',
    )!;
    act(() => notifyButton.click());

    renderComposer({
      onSubmit,
      mentionTarget: { ...target, ownershipEpoch: target.ownershipEpoch + 1 },
    });

    const refreshedNotifyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Notify Research agent"]',
    )!;
    expect(refreshedNotifyButton.getAttribute("aria-pressed")).toBe("false");

    const textarea = await changeTextarea("Follow-up after reassignment");
    await pressKey(textarea, "Enter");

    expect(onSubmit).toHaveBeenCalledWith("Follow-up after reassignment", undefined, undefined);
  });

  it("does not infer notification intent from mention-looking draft text", async () => {
    const draftKey = "task-comment-draft";
    localStorage.setItem(
      draftKey,
      `Ask [@Research agent](${buildAgentMentionHref(target.targetAgentId, target.icon)})`,
    );
    const onSubmit = renderComposer({ draftKey });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task message"]')!;

    expect(textarea.value).toBe("Ask @Research agent");
    expect(
      container.querySelector('button[aria-label="Notify Research agent"]')?.getAttribute("aria-pressed"),
    ).toBe("false");
    await pressKey(textarea, "Enter");

    expect(onSubmit).toHaveBeenCalledWith("Ask @Research agent", undefined, undefined);
  });

  it("can explicitly notify the owner from a reply", async () => {
    const onSubmit = renderComposer({
      replyTarget: {
        commentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        authorLabel: "Maya",
        preview: "Original comment",
      },
    });
    const notifyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Notify Research agent"]',
    )!;
    act(() => notifyButton.click());

    const textarea = await changeTextarea("Reply to @Research agent");

    expect(
      container.querySelector('[aria-label="Notify Research agent"]')?.getAttribute("aria-pressed"),
    ).toBe("true");

    await pressKey(textarea, "Enter");
    expect(onSubmit).toHaveBeenCalledWith(
      `[@Research agent](${buildAgentMentionHref(target.targetAgentId, target.icon)}) Reply to @Research agent`,
      { targetAgentId: target.targetAgentId, ownershipEpoch: target.ownershipEpoch },
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
  });

  it("explains terminal response-only access before notifying the owner", async () => {
    const onSubmit = renderComposer({ mentionIsResponseOnly: true });
    const notifyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Notify Research agent"]',
    )!;

    act(() => notifyButton.click());

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Research agent can read and answer but cannot make changes. The task status will not change.",
    );
    const submitButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message and notify owner"]',
    )!;
    expect(submitButton.textContent).toContain("Send & notify");

    const textarea = await changeTextarea("Please continue with the requested changes");
    await pressKey(textarea, "Enter");

    expect(onSubmit).toHaveBeenCalledWith(
      `[@Research agent](${buildAgentMentionHref(target.targetAgentId, target.icon)}) Please continue with the requested changes`,
      { targetAgentId: target.targetAgentId, ownershipEpoch: target.ownershipEpoch },
      undefined,
    );
  });

  it("keeps file attachment as a direct compact action", () => {
    renderComposer({ onAttachFile: async () => undefined });
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Upload files"]')!;
    const click = vi.spyOn(input, "click");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!;

    act(() => button.click());

    expect(click).toHaveBeenCalledOnce();
  });
});
