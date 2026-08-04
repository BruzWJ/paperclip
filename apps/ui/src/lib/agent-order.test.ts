import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  sortAgentsByDefaultSidebarOrder,
  sortAgentsByStoredOrder,
} from "./agent-order";

function makeAgent(
  overrides: Partial<Agent> & { id: string; name: string },
): Agent {
  return {
    reportsTo: null,
    ...overrides,
  } as Agent;
}

describe("agent ordering", () => {
  it("orders root siblings alphabetically without title-based priority", () => {
    const agents = [
      makeAgent({ id: "sam", name: "Sam", title: "Lead" }),
      makeAgent({ id: "ada", name: "Ada", title: "Engineer" }),
      makeAgent({ id: "board", name: "Board" }),
    ];

    expect(
      sortAgentsByDefaultSidebarOrder(agents).map((agent) => agent.id),
    ).toEqual(["ada", "board", "sam"]);
  });

  it("keeps reports grouped under their manager and sorts siblings by name", () => {
    const agents = [
      makeAgent({ id: "manager", name: "Sam" }),
      makeAgent({ id: "zoe", name: "Zoe", reportsTo: "manager" }),
      makeAgent({ id: "tom", name: "Tom", reportsTo: "manager" }),
    ];

    expect(
      sortAgentsByDefaultSidebarOrder(agents).map((agent) => agent.id),
    ).toEqual(["manager", "tom", "zoe"]);
  });

  it("respects an explicit stored order", () => {
    const agents = [
      makeAgent({ id: "sam", name: "Sam" }),
      makeAgent({ id: "board", name: "Board" }),
    ];

    expect(
      sortAgentsByStoredOrder(agents, ["sam", "board"]).map(
        (agent) => agent.id,
      ),
    ).toEqual(["sam", "board"]);
  });
});
