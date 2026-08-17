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
          currentOwnerValue={`agent:${target.targetAgentId}`}
          mentionTarget={target}
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
  it("opens the current owner suggestion from the compact @ action", () => {
    renderComposer();
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task message"]')!;
    const mentionButton = container.querySelector<HTMLButtonElement>('button[aria-label="Mention task owner"]')!;

    act(() => mentionButton.click());

    expect(textarea.value).toBe("@");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[aria-label="Agent mention suggestions"]')).not.toBeNull();
  });

  it("selects the current owner from @ autocomplete before Enter can submit", async () => {
    const onSubmit = renderComposer();
    const textarea = await changeTextarea("Ask @res");

    expect(document.body.textContent).toContain("@Research agent");
    expect(document.body.textContent).toContain("Current task owner");
    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]')!;
    const option = document.body.querySelector<HTMLElement>('[role="option"]')!;
    expect(textarea.getAttribute("aria-controls")).toBe(listbox.id);
    expect(textarea.getAttribute("aria-activedescendant")).toBe(option.id);

    await pressKey(textarea, "Enter");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Ask @Research agent ");
    expect(textarea.value).not.toContain("agent://");

    await pressKey(textarea, "Enter");
    expect(onSubmit).toHaveBeenCalledWith(
      `Ask [@Research agent](${buildAgentMentionHref(target.targetAgentId, target.icon)}) `,
      undefined,
      { targetAgentId: target.targetAgentId, ownershipEpoch: target.ownershipEpoch },
      undefined,
    );
  });

  it("never downgrades a selected mention after the ownership epoch changes", async () => {
    const onSubmit = renderComposer();
    const textarea = await changeTextarea("Ask @res");
    await pressKey(textarea, "Enter");

    renderComposer({
      onSubmit,
      mentionTarget: { ...target, ownershipEpoch: target.ownershipEpoch + 1 },
    });
    await pressKey(textarea, "Enter");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("task owner changed");
  });

  it("links only the exact occurrence selected from autocomplete", async () => {
    const onSubmit = renderComposer();
    const textarea = await changeTextarea("Literal @Research agent then @res");
    await pressKey(textarea, "Enter");
    await pressKey(textarea, "Enter");

    expect(onSubmit).toHaveBeenCalledWith(
      `Literal @Research agent then [@Research agent](${buildAgentMentionHref(target.targetAgentId, target.icon)}) `,
      undefined,
      { targetAgentId: target.targetAgentId, ownershipEpoch: target.ownershipEpoch },
      undefined,
    );
  });

  it("requires a fresh selection for a mention restored from a draft", async () => {
    const draftKey = "task-comment-draft";
    localStorage.setItem(
      draftKey,
      `Ask [@Research agent](${buildAgentMentionHref(target.targetAgentId, target.icon)})`,
    );
    const onSubmit = renderComposer({ draftKey });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task message"]')!;

    expect(textarea.value).toBe("Ask @Research agent");
    await pressKey(textarea, "Enter");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("from the suggestions");
  });

  it("removes selected mention intent when switching into reply mode", async () => {
    const onSubmit = renderComposer();
    const textarea = await changeTextarea("Ask @res");
    await pressKey(textarea, "Enter");

    renderComposer({
      onSubmit,
      replyTarget: {
        commentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        authorLabel: "Maya",
        preview: "Original comment",
      },
    });

    expect(textarea.value).toBe("Ask ");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("mention was removed");
    expect(textarea.getAttribute("role")).toBeNull();
  });

  it("suppresses mention controls in replies and submits @ text as an ordinary reply", async () => {
    const onSubmit = renderComposer({
      replyTarget: {
        commentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        authorLabel: "Maya",
        preview: "Original comment",
      },
    });
    const textarea = await changeTextarea("Reply to @Research agent");

    expect(container.querySelector('[aria-label="Mention task owner"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Agent mention suggestions"]')).toBeNull();
    expect(textarea.getAttribute("role")).toBeNull();

    await pressKey(textarea, "Enter");
    expect(onSubmit).toHaveBeenCalledWith(
      "Reply to @Research agent",
      undefined,
      undefined,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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

  it("disables all composer tools when comments are unavailable", () => {
    renderComposer({
      composerDisabledReason: "Comments are unavailable.",
      ownerOptions: [{ id: `agent:${target.targetAgentId}`, label: target.name }],
      onAttachFile: async () => undefined,
    });

    expect(container.querySelector('[aria-label="Attach files"]')).toBeNull();
    expect(container.querySelector('[aria-label="Mention task owner"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Owner"]')?.disabled).toBe(true);
  });
});
