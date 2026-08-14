// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmActionDialog } from "./ConfirmActionDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(element: ReactElement) {
  act(() => root.render(element));
}

function buttonWithText(label: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("ConfirmActionDialog", () => {
  it("opens from an asChild trigger and closes after a synchronous confirmation", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmActionDialog
        triggerAsChild
        trigger={<button type="button">Open confirmation</button>}
        title="Archive item?"
        description="This can be restored later."
        confirmLabel="Archive"
        onConfirm={onConfirm}
      />,
    );

    act(() => buttonWithText("Open confirmation")?.click());
    expect(document.body.textContent).toContain("Archive item?");

    await act(async () => {
      buttonWithText("Archive")?.click();
      await Promise.resolve();
    });

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
  });

  it("supports controlled open state", () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmActionDialog
        open
        onOpenChange={onOpenChange}
        title="Controlled confirmation"
        confirmLabel="Continue"
        onConfirm={vi.fn()}
      />,
    );

    act(() => buttonWithText("Cancel")?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open and disables actions until an async confirmation resolves", async () => {
    let resolveConfirm: (() => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    render(
      <ConfirmActionDialog
        defaultOpen
        title="Delete item?"
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        variant="destructive"
        onConfirm={onConfirm}
      />,
    );

    act(() => buttonWithText("Delete")?.click());

    const content = document.querySelector('[data-slot="alert-dialog-content"]');
    expect(content?.getAttribute("aria-busy")).toBe("true");
    expect(buttonWithText("Deleting…")?.disabled).toBe(true);
    expect(buttonWithText("Cancel")?.disabled).toBe(true);

    await act(async () => {
      resolveConfirm?.();
      await Promise.resolve();
    });

    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();
  });

  it("stays open and becomes actionable again when an async confirmation rejects", async () => {
    let rejectConfirm: ((reason?: unknown) => void) | undefined;
    render(
      <ConfirmActionDialog
        defaultOpen
        title="Delete item?"
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        onConfirm={() =>
          new Promise<void>((_resolve, reject) => {
            rejectConfirm = reject;
          })
        }
      />,
    );

    act(() => buttonWithText("Delete")?.click());
    await act(async () => {
      rejectConfirm?.(new Error("Delete failed"));
      await Promise.resolve();
    });

    expect(document.querySelector('[data-slot="alert-dialog-content"]')).not.toBeNull();
    expect(buttonWithText("Delete")?.disabled).toBe(false);
    expect(buttonWithText("Cancel")?.disabled).toBe(false);
  });

  it("disables confirmation without preventing cancellation", () => {
    render(
      <ConfirmActionDialog
        defaultOpen
        title="Unavailable action"
        confirmLabel="Continue"
        disabled
        onConfirm={vi.fn()}
      />,
    );

    expect(buttonWithText("Continue")?.disabled).toBe(true);
    expect(buttonWithText("Cancel")?.disabled).toBe(false);
  });
});
