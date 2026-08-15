// @vitest-environment jsdom

import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { EnvironmentVariablesEditor } from "./";
import { SecretPicker } from "../secrets/pickers/EnvironmentVariableSecretPicker";

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

  it("renders header + a row per binding, no trailing ghost row", () => {
    render(
      <EnvironmentVariablesEditor
        value={{
          NODE_ENV: { type: "plain", value: "production" },
          GH: { type: "secret_ref", secretId: "s1", version: 2 },
        }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    expect(nameInputs()).toHaveLength(2);
    expect(container.textContent).toContain("Name");
    expect(container.textContent).toContain("Value");
    // Version tag reflects the actual bound version (not a static "latest").
    const versionTag = container.querySelector('button[aria-label="Version"]');
    expect(versionTag?.textContent).toBe("v2");
  });

  it("keeps long secret names clear of the latest version control", () => {
    const longSecret = makeSecret("long", {
      name: "/paperclip-cloud/prod/provider/resend/api-key-with-a-very-long-name",
      latestVersion: 4,
    });

    render(
      <EnvironmentVariablesEditor
        value={{
          RESEND_API_KEY: { type: "secret_ref", secretId: "long", version: "latest" },
        }}
        secrets={[longSecret]}
        onChange={() => {}}
        onCreateSecret={async () => longSecret}
      />,
    );

    const combobox = container.querySelector<HTMLElement>('[role="combobox"]')!;
    const selectedLabel = combobox.querySelector<HTMLElement>("[title] span.truncate");
    const versionTag = container.querySelector<HTMLButtonElement>('button[aria-label="Version"]')!;

    expect(versionTag.textContent).toBe("latest");
    expect(combobox.className).toContain("has-[>svg]:!pr-24");
    expect(selectedLabel?.textContent).toBe(longSecret.name);
    expect(selectedLabel?.className).toContain("flex-1");
  });

  it("shows the empty state with no bindings", () => {
    render(
      <EnvironmentVariablesEditor
        value={{}}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    expect(container.textContent).toContain("No environment variables");
    expect(nameInputs()).toHaveLength(0);
  });

  it("appends a row when + Add variable is clicked", async () => {
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
    expect(nameInputs()).toHaveLength(1);
  });

  it("does not emit when + Add variable only creates an empty draft row", async () => {
    const onChange = vi.fn();
    render(
      <EnvironmentVariablesEditor
        value={{}}
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
    expect(nameInputs()).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves plain bindings only when Save is clicked", async () => {
    const onChange = vi.fn();
    render(
      <EnvironmentVariablesEditor
        value={{ FOO: { type: "plain", value: "" } }}
        secrets={secrets}
        onChange={onChange}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unsaved changes");
    saveButton().click();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith({ FOO: { type: "plain", value: "bar" } });
  });

  it("flushes unsaved editor changes before an enclosing form submits", async () => {
    const submittedValues: Array<Record<string, EnvBinding> | undefined> = [];

    function FormHarness() {
      const [value, setValue] = useState<Record<string, EnvBinding>>({
        FOO: { type: "plain", value: "" },
      });
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submittedValues.push(value);
          }}
        >
          <EnvironmentVariablesEditor
            value={value}
            secrets={secrets}
            onChange={(next) => setValue(next ?? {})}
            onCreateSecret={async () => secrets[0]}
          />
          <button type="submit">Outer save</button>
        </form>
      );
    }

    render(<FormHarness />);
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const outerSave = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Outer save"),
    )!;
    outerSave.click();
    await flush();

    expect(submittedValues).toEqual([{ FOO: { type: "plain", value: "bar" } }]);
  });

  it("flushes unsaved editor changes before an external save button reads parent state", async () => {
    const savedValues: Array<Record<string, EnvBinding>> = [];

    function SaveButtonHarness() {
      const [value, setValue] = useState<Record<string, EnvBinding>>({
        FOO: { type: "plain", value: "" },
      });
      return (
        <div>
          <EnvironmentVariablesEditor
            value={value}
            secrets={secrets}
            onChange={(next) => setValue(next ?? {})}
            onCreateSecret={async () => secrets[0]}
          />
          <button type="button" onClick={() => savedValues.push(value)}>
            Save settings
          </button>
        </div>
      );
    }

    render(<SaveButtonHarness />);
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const outerSave = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Save settings"),
    )!;
    outerSave.click();
    await flush();

    expect(savedValues).toEqual([{ FOO: { type: "plain", value: "bar" } }]);
  });

  it("makes unsaved fields and save controls prominent while editing", async () => {
    render(
      <EnvironmentVariablesEditor
        value={{ FOO: { type: "plain", value: "" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(valueInput, "bar");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    const unsavedBar = [...container.querySelectorAll<HTMLElement>('[role="status"]')].find((node) =>
      node.textContent?.includes("Unsaved changes"),
    );
    const save = saveButton();
    const revert = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Revert",
    )!;

    expect(unsavedBar?.dataset.slot).toBe("alert");
    expect(save.dataset.slot).toBe("button");
    expect(save.disabled).toBe(false);
    expect(revert.dataset.slot).toBe("button");
    expect(revert.disabled).toBe(false);
  });

  it("lists which variables changed in the unsaved-changes banner", async () => {
    render(
      <EnvironmentVariablesEditor
        value={{ FOO: { type: "plain", value: "old" }, BAR: { type: "plain", value: "keep" } }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

    // Edit FOO's value.
    const valueInput = container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    setter.call(valueInput, "new");
    valueInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(container.textContent).toContain("Edited: FOO");

    // Remove BAR.
    const removeButtons = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="Remove"]')];
    removeButtons.at(-1)!.click();
    await flush();
    expect(container.textContent).toContain("Removed: BAR");

    // Add a brand-new variable.
    const addButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add variable"),
    )!;
    addButton.click();
    await flush();
    const newNameInput = nameInputs().at(-1)!;
    setter.call(newNameInput, "API_TOKEN");
    newNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(container.textContent).toContain("New: API_TOKEN");
    expect(container.textContent).toContain("Edited: FOO");
    expect(container.textContent).toContain("Removed: BAR");
  });

  it("does not show a phantom unsaved-changes banner for a saved value that round-trips lossily", () => {
    // Incomplete refs and unpadded names are dropped by the editor's emit
    // semantics — the committed baseline must drop them too, or the banner
    // shows the moment the form opens with no user edits.
    render(
      <EnvironmentVariablesEditor
        value={{
          "  PADDED_NAME  ": { type: "plain", value: "x" },
          DANGLING_SECRET: { type: "secret_ref", secretId: "", version: "latest" },
          DANGLING_USER_SECRET: { type: "user_secret_ref", key: "", version: "latest", required: true },
        }}
        secrets={secrets}
        onChange={() => {}}
        onCreateSecret={async () => secrets[0]}
      />,
    );
    expect(container.textContent).not.toContain("Unsaved changes");
  });
});
