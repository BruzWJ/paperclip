// @vitest-environment jsdom

import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { EnvironmentVariablesEditor } from "./index";
import { SecretPicker } from "./SecretPicker";

// Radix (DropdownMenu/Popover) relies on Pointer Capture APIs that jsdom omits.
const OriginalPointerEvent = globalThis.PointerEvent;
beforeAll(() => {
  if (!globalThis.PointerEvent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.PointerEvent = MouseEvent as any;
  }
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  if (!globalThis.ResizeObserver) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }
});
afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.PointerEvent = OriginalPointerEvent as any;
});

function makeSecret(id: string, overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id,
    companyId: "co",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: id,
    name: id.toUpperCase(),
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

// Radix DropdownMenu opens/selects on the pointerdown→pointerup sequence, not a
// bare click; drive both so jsdom exercises the real dismissal-layer path.
function pointerClick(el: Element) {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  (el as HTMLElement).click();
}

// Deterministic settle for the nested DropdownMenu/combobox → Popover deferred-
// open regression tests. Those flows open the anchored popover from inside a
// closing menu via `window.setTimeout(…, 0)` (PAP-12476/12477/12478). Under real
// timers, jsdom orders the menu's focus-return (a `focusin` that Radix reads as
// `focusOutside` → dismiss) against that deferred open non-deterministically, so
// the popover *sometimes* opens-then-instantly-closes — flaky. `vi.useFakeTimers`
// makes that ordering deterministic (matching the real-browser path where the
// focus-return settles before the macrotask), while still running the deferred
// `setTimeout` — so a *synchronous* (unfixed) open would still be dismissed here.
function settleFakeTimers() {
  flushSync(() => {});
  vi.runAllTimers();
  flushSync(() => {});
}

describe("EnvironmentVariablesEditor", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function render(node: React.ReactNode) {
    root = createRoot(container);
    flushSync(() => root!.render(node));
  }

  function rerender(node: React.ReactNode) {
    flushSync(() => root!.render(node));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    // Restore real timers first (the PAP-12478 test swaps in fake timers and may
    // exit without restoring if it throws) so unmount cleanup runs on real timers
    // and gets drained below.
    vi.useRealTimers();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    // Drain any pending macrotasks (deferred popover-open timers, Radix's
    // focus-restoration timers) so a timer scheduled by this test can't fire
    // mid-way through the next one and dismiss its freshly-opened popover — that
    // cross-test leak is what made the real-timer sibling regression tests flaky.
    await flush();
    for (const child of [...document.body.children]) {
      child.remove();
    }
    document.body.style.pointerEvents = "";
    vi.restoreAllMocks();
  });

  const secrets = [makeSecret("s1", { name: "GITHUB_TOKEN", latestVersion: 3 })];

  function nameInputs() {
    return [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable name"]')];
  }

  function saveButton() {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Save",
    )!;
  }

  it("warns via beforeunload only while the draft is dirty", async () => {
    render(
      <EnvironmentVariablesEditor
        value={{ FOO: { type: "plain", value: "" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );

    function dispatchBeforeUnload(): boolean {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }

    expect(dispatchBeforeUnload()).toBe(false);

    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(dispatchBeforeUnload()).toBe(true);

    const revert = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Revert",
    )!;
    revert.click();
    await flush();
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it("marks a newly typed variable name as unsaved before saving", async () => {
    render(
      <EnvironmentVariablesEditor
        value={{}}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const addButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add variable"),
    )!;
    addButton.click();
    await flush();

    const nameInput = nameInputs()[0]!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "API_TOKEN");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    expect(nameInput.className).toContain("border-amber-500/70");
    expect(container.textContent).toContain("Unsaved changes");
  });

  it("does not emit or remount while typing a new variable before manual save", async () => {
    const onChange = vi.fn();
    const savedValue: Record<string, EnvBinding> = {
      ZED: { type: "plain", value: "z" },
      ALPHA: { type: "plain", value: "a" },
    };
    render(
      <EnvironmentVariablesEditor
        value={savedValue}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const addButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add variable"),
    )!;
    addButton.click();
    await flush();

    const newNameInput = nameInputs().at(-1)!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(newNameInput, "ca");
    newNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    newNameInput.focus();
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(newNameInput);

    rerender(
      <EnvironmentVariablesEditor
        value={savedValue}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(newNameInput);
    expect(nameInputs().at(-1)).toBe(newNameInput);

    setter.call(newNameInput, "carol");
    newNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({
      ZED: { type: "plain", value: "z" },
      ALPHA: { type: "plain", value: "a" },
      carol: { type: "plain", value: "" },
    });
  });

  it("keeps the active row mounted when a manual save echo returns an equivalent value", async () => {
    const onChange = vi.fn();
    const emptyValue: Record<string, EnvBinding> = {};
    const savedValue: Record<string, EnvBinding> = { API_TOKEN: { type: "plain", value: "secret-value" } };
    render(
      <EnvironmentVariablesEditor
        value={emptyValue}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const addButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add variable"),
    )!;
    addButton.click();
    await flush();

    const [nameInput] = nameInputs();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(nameInput, "API_TOKEN");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    setter.call(valueInput, "secret-value");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    valueInput.focus();
    await flush();
    expect(document.activeElement).toBe(valueInput);
    expect(onChange).not.toHaveBeenCalled();
    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(savedValue);

    rerender(
      <EnvironmentVariablesEditor
        value={{ API_TOKEN: { type: "plain", value: "secret-value" } }}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    await flush();

    expect(document.activeElement).toBe(valueInput);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')).toBe(valueInput);
  });

  it("emits undefined when the last binding is removed", async () => {
    const onChange = vi.fn();
    render(
      <EnvironmentVariablesEditor
        value={{ FOO: { type: "plain", value: "x" } }}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const removeButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!;
    removeButton.click();
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("disables inputs in read-only mode", () => {
    render(
      <EnvironmentVariablesEditor
        value={{ FOO: { type: "plain", value: "x" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
        disabled
      />,
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!.disabled).toBe(
      true,
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!.disabled).toBe(
      true,
    );
  });

  it("renders name warnings as a row spanning the name and value columns", () => {
    render(
      <EnvironmentVariablesEditor
        value={{ PAPERCLIP_PAGE_BASE_URL: { type: "plain", value: "https://pages.paperclip.ing" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );

    const nameInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    const warning = [...container.querySelectorAll<HTMLParagraphElement>("p")].find((node) =>
      node.textContent?.includes("Reserved prefix"),
    );

    expect(warning, "reserved-prefix warning should render").toBeTruthy();
    expect(nameInput.getAttribute("aria-describedby")).toBe(warning!.id);
    expect(warning!.parentElement?.contains(nameInput), "warning should stay in the row grid").toBe(true);
    expect(warning!.parentElement).not.toBe(nameInput.parentElement);
    expect(warning!.className).toContain("col-span-2");
    expect(warning!.className).toContain("@[40rem]/env:row-start-2");
  });

  it("bulk-imports a dotenv paste into an empty name field", async () => {
    const onChange = vi.fn();
    render(
      <EnvironmentVariablesEditor
        value={{}}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    // Add an empty row to paste into.
    const addButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add variable"),
    )!;
    addButton.click();
    await flush();
    const nameInput = nameInputs()[0]!;
    const clipboardData = { getData: () => "A=1\nB=2\nC=3" } as unknown as DataTransfer;
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
    Object.defineProperty(pasteEvent, "clipboardData", { value: clipboardData });
    nameInput.dispatchEvent(pasteEvent);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({
      A: { type: "plain", value: "1" },
      B: { type: "plain", value: "2" },
      C: { type: "plain", value: "3" },
    });
  });

  it("bulk-imports dotenv updates without mutating the committed row baseline", async () => {
    render(
      <EnvironmentVariablesEditor
        value={{ A: { type: "plain", value: "old" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const addButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Add variable"),
    )!;
    addButton.click();
    await flush();

    const targetNameInput = nameInputs().at(-1)!;
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "A=new" } as unknown as DataTransfer,
    });
    targetNameInput.dispatchEvent(pasteEvent);
    await flush();

    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const valueCell = valueInput.closest<HTMLDivElement>(".relative.flex");
    expect(valueInput.value).toBe("new");
    expect(valueCell?.className).toContain("border-amber-500/70");
  });

  it("auto-detects a sensitive value and offers a value-preserving Store-as-secret popover", async () => {
    // A sensitive KEY (matches the shared regex) surfaces the ShieldAlert
    // affordance and auto-masks the value input (§6.6).
    render(
      <EnvironmentVariablesEditor
        value={{ STRIPE_API_KEY: { type: "plain", value: "supersecretvalue" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    expect(valueInput.type).toBe("password"); // auto-masked
    const storeButton = container.querySelector<HTMLButtonElement>(
      'button[title^="This value looks sensitive"]',
    );
    expect(storeButton, "sensitive Store-as-secret affordance should render").toBeTruthy();
    storeButton!.click();
    await flush();
    // The store popover carries the typed value forward (not discarded).
    expect(document.body.textContent).toContain("Store value as secret");
    const secretValueField = document.querySelector<HTMLInputElement>('input[aria-label="Secret value"]');
    expect(secretValueField?.value).toBe("supersecretvalue");
  });
});
