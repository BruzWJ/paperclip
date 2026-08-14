// @vitest-environment jsdom

import { act, createRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntityOption } from "@/lib/entity-selector";
import { AgentIconPicker } from "../AgentIconPicker";
import { EntityCombobox } from "./EntityCombobox";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const options: EntityOption[] = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta" },
  { id: "gamma", label: "Gamma", searchText: "special expertise" },
];

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  flushSync(() => {});
}

function visibleItems() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).filter(
    (item) => !item.hidden,
  );
}

async function setSearchValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flushReact();
}

async function clickTrigger(trigger: HTMLButtonElement) {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await flushReact();
}

function ControlledCombobox({
  initialValue = "beta",
  onValueChange,
  onConfirm,
  triggerRef,
  disabled,
  openOnFocus,
}: {
  initialValue?: string;
  onValueChange?: (value: string) => void;
  onConfirm?: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
  openOnFocus?: boolean;
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <EntityCombobox
      ref={triggerRef}
      value={value}
      options={options}
      type="entity"
      ariaLabel="Entity"
      placeholder="Choose entity"
      noneLabel="No entity"
      recentOptionIds={["gamma", "alpha"]}
      disabled={disabled}
      openOnFocus={openOnFocus}
      onValueChange={(nextValue) => {
        setValue(nextValue);
        onValueChange?.(nextValue);
      }}
      onConfirm={onConfirm}
      searchPlaceholder="Search entities..."
      renderValue={(option) => (
        <span data-testid="rich-value">{option ? `Selected ${option.label}` : "No selection"}</span>
      )}
      renderOption={(option) => <span data-rich-option={option.id || "none"}>{option.label}</span>}
    />
  );
}

describe("EntityCombobox", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(0), 0);
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("orders the selected and recent entities and supports rich rendering", async () => {
    flushSync(() => root!.render(<ControlledCombobox />));

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Entity"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("Selected Beta");

    await act(async () => trigger?.focus());
    await flushReact();

    expect(visibleItems().map((item) => item.textContent?.trim())).toEqual([
      "Beta",
      "Gamma",
      "Alpha",
      "No entity",
    ]);
    expect(document.querySelector('[data-rich-option="gamma"]')).not.toBeNull();
  });

  it("supports a square icon-only trigger without rendering the chevrons indicator", () => {
    flushSync(() =>
      root!.render(
        <EntityCombobox
          value="beta"
          options={options}
          type="entity"
          ariaLabel="Entity icon"
          placeholder="Choose entity"
          noneLabel="No entity"
          onValueChange={() => undefined}
          triggerProps={{ size: "icon-lg" }}
          showTriggerIndicator={false}
          renderValue={() => <span data-testid="selected-icon">Icon</span>}
        />,
      ),
    );

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Entity icon"]');
    const value = container.querySelector<HTMLElement>('[data-testid="selected-icon"]')?.parentElement;

    expect(trigger?.className).toContain("size-10");
    expect(trigger?.className).not.toContain("w-full");
    expect(value?.className).not.toContain("flex-1");
    expect(trigger?.querySelector(".lucide-chevrons-up-down")).toBeNull();
  });

  it("targets cmdk's inner list sizer for the agent icon grid", async () => {
    flushSync(() => root!.render(<AgentIconPicker value="bot" onChange={() => undefined} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Change agent icon"]');

    await clickTrigger(trigger!);

    const list = document.querySelector<HTMLElement>('[data-slot="command-list"]');
    const sizer = list?.querySelector<HTMLElement>("[cmdk-list-sizer]");
    const directItems = Array.from(sizer?.children ?? []).filter((child) =>
      child.matches('[data-slot="command-item"]'),
    );

    expect(list?.className).toContain("[&_[cmdk-list-sizer]]:grid");
    expect(list?.className).toContain("[&_[cmdk-list-sizer]]:grid-cols-7");
    expect(directItems.length).toBeGreaterThan(7);
  });

  it("matches searchText in addition to the visible label", async () => {
    flushSync(() => root!.render(<ControlledCombobox />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Entity"]');
    await act(async () => trigger?.focus());
    await flushReact();

    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]');
    expect(input).not.toBeNull();
    await setSearchValue(input!, "special");

    expect(visibleItems().map((item) => item.textContent?.trim())).toEqual(["Gamma"]);
  });

  it("clears the search query after closing and reopening", async () => {
    flushSync(() => root!.render(<ControlledCombobox />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Entity"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.focus());
    await flushReact();

    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]');
    expect(input).not.toBeNull();
    await setSearchValue(input!, "special");
    expect(visibleItems().map((item) => item.textContent?.trim())).toEqual(["Gamma"]);

    await act(async () => {
      visibleItems()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    await clickTrigger(trigger!);
    const reopenedInput = document.querySelector<HTMLInputElement>('[data-slot="command-input"]');
    expect(reopenedInput?.value).toBe("");
    expect(visibleItems().map((item) => item.textContent?.trim())).toEqual([
      "Gamma",
      "Alpha",
      "No entity",
      "Beta",
    ]);
  });

  it("stays closed when Escape restores focus to the trigger", async () => {
    const onConfirm = vi.fn();
    flushSync(() => root!.render(<ControlledCombobox onConfirm={onConfirm} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Entity"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.focus());
    await flushReact();

    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]');
    expect(input).not.toBeNull();
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flushReact();
    await flushReact();

    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("decodes the none option and runs the post-selection focus handoff", async () => {
    const onValueChange = vi.fn();
    const onConfirm = vi.fn();
    flushSync(() => root!.render(<ControlledCombobox onValueChange={onValueChange} onConfirm={onConfirm} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Entity"]');
    await act(async () => trigger?.focus());
    await flushReact();

    const noneItem = visibleItems().find((item) => item.textContent?.trim() === "No entity");
    expect(noneItem).not.toBeUndefined();
    await act(async () => {
      noneItem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(onValueChange).toHaveBeenCalledWith("");
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.textContent).toContain("No selection");
  });

  it("forwards the trigger ref and respects focus and disabled behavior", async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    flushSync(() => root!.render(<ControlledCombobox triggerRef={triggerRef} />));

    expect(triggerRef.current).toBe(
      container.querySelector<HTMLButtonElement>('button[aria-label="Entity"]'),
    );
    await act(async () => triggerRef.current?.focus());
    await flushReact();
    expect(triggerRef.current?.getAttribute("aria-expanded")).toBe("true");

    flushSync(() =>
      root!.render(<ControlledCombobox key="manual-open" triggerRef={triggerRef} openOnFocus={false} />),
    );
    await act(async () => triggerRef.current?.focus());
    await flushReact();
    expect(triggerRef.current?.getAttribute("aria-expanded")).toBe("false");
    await clickTrigger(triggerRef.current!);
    expect(triggerRef.current?.getAttribute("aria-expanded")).toBe("true");

    flushSync(() =>
      root!.render(
        <ControlledCombobox key="disabled" triggerRef={triggerRef} disabled openOnFocus={false} />,
      ),
    );
    expect(triggerRef.current?.disabled).toBe(true);
    expect(triggerRef.current?.getAttribute("aria-expanded")).toBe("false");
  });
});
