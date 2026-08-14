// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormDialog, LabeledFormField, SettingsSwitchField } from "./FormPatterns";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FormPatterns", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(element: ReactElement) {
    act(() => root.render(element));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("renders Kibo's labeled vertical field composition", () => {
    render(
      <LabeledFormField
        label="Project name"
        labelActions={<Button type="button">Reset</Button>}
        labelClassName="test-label"
        labelFor="project-name"
        description="Visible to the team."
      >
        <Input id="project-name" />
      </LabeledFormField>,
    );

    const label = container.querySelector('label[for="project-name"]');
    expect(label?.textContent).toBe("Project name");
    expect(label?.className).toContain("test-label");
    expect(container.querySelector("button")?.textContent).toBe("Reset");
    expect(container.querySelector('[data-slot="field-description"]')?.textContent).toBe(
      "Visible to the team.",
    );
  });

  it("associates a settings label with its switch", () => {
    const onCheckedChange = vi.fn();
    render(
      <SettingsSwitchField
        id="public-project"
        label="Make project public"
        description="Anyone can see it."
        error="Choose a value."
        errorId="public-project-error"
        invalid
        aria-describedby="public-project-error"
        onCheckedChange={onCheckedChange}
      />,
    );

    const label = container.querySelector<HTMLLabelElement>('label[for="public-project"]');
    const control = container.querySelector<HTMLButtonElement>('#public-project[role="switch"]');
    expect(label).not.toBeNull();
    expect(control).not.toBeNull();
    expect(container.querySelector('[data-slot="field"]')?.getAttribute("data-invalid")).toBe("true");
    expect(container.querySelector("#public-project-error")?.textContent).toBe("Choose a value.");

    act(() => control?.click());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("renders the standard Kibo form-dialog regions", () => {
    const onOpenChange = vi.fn();
    render(
      <FormDialog
        open
        onOpenChange={onOpenChange}
        title="Subscribe"
        description="Get the latest updates."
        headerLeading={<span data-testid="dialog-context">Newsletter</span>}
        headerActions={<Button type="button" aria-label="Expand dialog" />}
        headerClassName="test-header"
        footerClassName="test-footer"
        footer={<Button type="button">Save</Button>}
      >
        <Input aria-label="Email" />
      </FormDialog>,
    );

    expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("Subscribe");
    expect(document.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
      "Get the latest updates.",
    );
    expect(document.querySelector('[data-slot="dialog-footer"]')?.textContent).toBe("Save");
    expect(document.querySelector('[data-slot="dialog-header"]')?.className).toContain("test-header");
    expect(document.querySelector('[data-slot="dialog-footer"]')?.className).toContain("test-footer");
    expect(document.querySelector('[data-testid="dialog-context"]')?.textContent).toBe("Newsletter");
    expect(document.querySelector('button[aria-label="Expand dialog"]')).not.toBeNull();
  });
});
