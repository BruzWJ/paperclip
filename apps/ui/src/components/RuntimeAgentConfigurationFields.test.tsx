// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeAgentConfigurationFields,
  createEmptyRuntimeAgentConfigurationValues,
  type RuntimeAgentConfigurationValues,
} from "./RuntimeAgentConfigurationFields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("RuntimeAgentConfigurationFields", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render({
    value = createEmptyRuntimeAgentConfigurationValues(),
    onChange = () => undefined,
  }: {
    value?: RuntimeAgentConfigurationValues;
    onChange?: (value: RuntimeAgentConfigurationValues) => void;
  } = {}) {
    act(() => {
      root.render(
        <RuntimeAgentConfigurationFields value={value} onChange={onChange} />,
      );
    });
    return onChange;
  }

  it("initializes only the configurable action grants", () => {
    expect(
      createEmptyRuntimeAgentConfigurationValues().actionGrants,
    ).toEqual({
      issue_create: false,
      mention_board: false,
      agent_hire: false,
      agent_configure: false,
      list_all_agents: false,
      list_parent_agents: false,
    });
  });

  it("uses one nine-cell context access matrix for the agent context grants", () => {
    const value = createEmptyRuntimeAgentConfigurationValues();
    const onChange = vi.fn();
    render({ value, onChange });

    const matrix = container.querySelector(
      '[data-testid="agent-context-access-matrix"]',
    );
    expect(matrix).not.toBeNull();
    expect(matrix!.querySelectorAll('[role="checkbox"]')).toHaveLength(9);
    expect(matrix!.querySelectorAll('[aria-label$=": blocked"]')).toHaveLength(
      9,
    );
    expect(container.textContent).not.toContain("Carry current-issue session");
    expect(container.textContent).not.toContain("Current issue · comments");

    const currentContent = matrix!.querySelector<HTMLButtonElement>(
      '[aria-label="Current issue Content: blocked"]',
    );
    expect(currentContent).not.toBeNull();
    act(() => currentContent!.click());

    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      contextGrants: {
        ...value.contextGrants,
        carry_context: true,
      },
    });
  });

  it("shows an explicit managed grant for collective Board requests", () => {
    render();

    expect(container.textContent).toContain("Can mention Board");
    expect(container.textContent).toContain(
      "Post a canonical issue comment to the collective Board.",
    );
  });

  it("combines direct-child creation and assignment and derives lifecycle access", () => {
    render();

    expect(container.textContent).toContain("Create and assign issues");
    expect(container.textContent).toContain(
      "Create direct child issues and reassign eligible direct children created by this execution.",
    );
    expect(container.textContent).toContain(
      "Issue updates are relationship-derived",
    );
    expect(container.textContent).toContain(
      "canonically mentions its counterpart automatically",
    );
    expect(container.textContent).toContain(
      "Terminal updates remain owner-only.",
    );
    expect(container.textContent).not.toContain("Assign issues");
    expect(container.textContent).not.toContain("Update issue lifecycle");
  });
});
