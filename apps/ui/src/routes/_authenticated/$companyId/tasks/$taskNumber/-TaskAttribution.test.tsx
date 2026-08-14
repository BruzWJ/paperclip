// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Agent, Task } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanyUserProfile } from "@/lib/company-members";
import { TaskAttributionByline } from "./-TaskAttribution";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT_ID = "agent-owner";
const USER_ID = "user-originator";
const USER_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

class LoadedImage {
  complete = true;
  naturalWidth = 1;
  crossOrigin: string | null = null;
  referrerPolicy = "";
  src = "";

  addEventListener() {}
  removeEventListener() {}
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Codex Coder",
    icon: "code",
    ...overrides,
  } as Agent;
}

function attributedTask(): Task {
  return {
    ownerKind: "agent",
    ownerAgentId: AGENT_ID,
    ownerUserId: null,
    creatorKind: "user/board",
    creatorUserId: USER_ID,
    creatorAuthorityId: null,
    responsibleUserId: null,
  } as unknown as Task;
}

describe("TaskAttributionByline", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("Image", LoadedImage);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders configured agent identity separately from a user's profile avatar", async () => {
    const agentMap = new Map([[AGENT_ID, agent()]]);
    const userProfileMap = new Map<string, CompanyUserProfile>([
      [USER_ID, { label: "Board Operator", image: USER_IMAGE }],
    ]);
    const userLabelMap = new Map([[USER_ID, "Board Operator"]]);

    await act(async () => {
      root.render(
        <TaskAttributionByline
          task={attributedTask()}
          agentMap={agentMap}
          userProfileMap={userProfileMap}
          userLabelMap={userLabelMap}
        />,
      );
    });

    expect(container.textContent).toContain("Owner");
    expect(container.textContent).toContain("Codex Coder");
    expect(container.textContent).toContain("Originator");
    expect(container.textContent).toContain("Board Operator");

    const ownerAvatar = container.querySelector('[data-testid="task-owner-avatar"]');
    expect(ownerAvatar?.getAttribute("role")).toBe("img");
    expect(ownerAvatar?.getAttribute("aria-label")).toBe("Owner: Codex Coder");
    expect(ownerAvatar?.querySelector("svg")).not.toBeNull();
    expect(ownerAvatar?.querySelector('[data-slot="avatar-image"]')).toBeNull();

    const originatorAvatar = container.querySelector('[data-testid="task-originator-avatar"]');
    expect(originatorAvatar?.getAttribute("role")).toBe("img");
    expect(originatorAvatar?.getAttribute("aria-label")).toBe("Originator: Board Operator");
    expect(originatorAvatar?.querySelector('[data-slot="avatar-image"]')?.getAttribute("src")).toBe(
      USER_IMAGE,
    );
  });

  it("shows the creating agent when a human originator was reached through that agent", async () => {
    const viaAgentId = "agent-creator";
    const task = {
      ...attributedTask(),
      creatorKind: "agent-execution",
      creatorUserId: null,
      creatorAuthorityId: viaAgentId,
      responsibleUserId: USER_ID,
    } as unknown as Task;
    const agentMap = new Map([
      [AGENT_ID, agent()],
      [viaAgentId, agent({ id: viaAgentId, name: "Planner Agent", icon: "bot" })],
    ]);

    await act(async () => {
      root.render(
        <TaskAttributionByline
          task={task}
          agentMap={agentMap}
          userProfileMap={new Map([[USER_ID, { label: "Product Lead", image: null }]])}
          userLabelMap={new Map([[USER_ID, "Product Lead"]])}
        />,
      );
    });

    expect(container.textContent).toContain("Product Lead");
    expect(container.textContent).toContain("via Planner Agent");
    expect(
      container.querySelector('[data-testid="task-originator-avatar"]')?.getAttribute("aria-label"),
    ).toBe("Originator: Product Lead, via Planner Agent");
  });
});
