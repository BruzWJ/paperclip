// @vitest-environment jsdom

import { act } from "react";
import { expect, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Select relies on PointerEvent, pointer capture, and ResizeObserver,
// none of which jsdom implements. Stub them so the dropdown can open in tests.
if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}
if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
}
export class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

// SecretBindingPicker pulls in CompanyContext + react-query. Stub it so we can
// exercise SecretField in isolation. The stub renders a select with the same
// onChange contract as the real picker.
vi.mock("@/features/secrets/pickers/SecretBindingPicker", () => ({
  SecretBindingPicker: ({
    value,
    onChange,
    disabled,
  }: {
    value: { secretId: string } | null;
    onChange: (next: { secretId: string } | null) => void;
    disabled?: boolean;
  }) => (
    <select
      data-testid="secret-binding-picker"
      value={value?.secretId ?? ""}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next ? { secretId: next } : null);
      }}
      disabled={disabled}
    >
      <option value="">none</option>
      <option value="11111111-1111-4111-8111-111111111111">existing-secret</option>
    </select>
  ),
}));

const { JsonSchemaForm, getDefaultValues } = await import("./-JsonSchemaForm");

export const numericEnumSchema = {
  type: "object" as const,
  properties: {
    memory: {
      type: "integer" as const,
      enum: [1, 2, 4, 8],
    },
  },
};

export async function openSelect(container: HTMLElement) {
  const trigger = container.querySelector<HTMLElement>('[role="combobox"]');
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export function optionByLabel(label: string): Element | undefined {
  return Array.from(document.querySelectorAll('[role="option"]')).find(
    (option) => option.textContent?.trim() === label,
  );
}

export { JsonSchemaForm, getDefaultValues };
