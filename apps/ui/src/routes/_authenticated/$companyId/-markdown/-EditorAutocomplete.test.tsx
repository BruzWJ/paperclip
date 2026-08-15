import { describe, expect, it, vi } from "vitest";

import {
  buildMentionSuggestionItems,
  buildRoutineSuggestionItems,
  createEditorSlashSuggestions,
} from "./-EditorAutocomplete";

function commandChain() {
  const chain = {
    focus: vi.fn(),
    deleteRange: vi.fn(),
    insertContent: vi.fn(),
    run: vi.fn(),
  };
  chain.focus.mockReturnValue(chain);
  chain.deleteRange.mockReturnValue(chain);
  chain.insertContent.mockReturnValue(chain);
  return chain;
}

describe("Kibo editor autocomplete pattern", () => {
  it("inserts agent mentions from the @ suggestion contract", () => {
    const [item] = buildMentionSuggestionItems([
      {
        id: "agent:agent-1",
        kind: "agent",
        name: "Ada",
        agentId: "00000000-0000-4000-8000-000000000001",
        agentIcon: null,
      },
    ]);
    const chain = commandChain();

    item?.execute({
      editor: { chain: () => chain } as never,
      range: { from: 2, to: 6 },
    });

    expect(item?.title).toBe("@Ada");
    expect(chain.deleteRange).toHaveBeenCalledWith({ from: 2, to: 6 });
    expect(chain.insertContent).toHaveBeenCalledWith(
      "[@Ada](agent://00000000-0000-4000-8000-000000000001) ",
      { contentType: "markdown" },
    );
    expect(chain.run).toHaveBeenCalledOnce();
  });

  it("inserts company routines alongside Kibo's native slash commands", () => {
    const [item] = buildRoutineSuggestionItems([
      {
        id: "routine:routine-1",
        kind: "routine",
        routineId: "00000000-0000-4000-8000-000000000002",
        name: "Daily review",
        status: "active",
        href: "routine://00000000-0000-4000-8000-000000000002",
        aliases: ["routine:Daily review", "Daily review", "routine-1"],
      },
    ]);
    const chain = commandChain();

    item?.execute({
      editor: { chain: () => chain } as never,
      range: { from: 0, to: 14 },
    });

    expect(item?.title).toBe("/routine:Daily review");
    expect(chain.insertContent).toHaveBeenCalledWith(
      "[/routine:Daily review](routine://00000000-0000-4000-8000-000000000002) ",
      { contentType: "markdown" },
    );
    expect(chain.run).toHaveBeenCalledOnce();
  });

  it("caps the open slash menu while keeping searched routines outside the initial window findable", async () => {
    const routines = Array.from({ length: 100 }, (_, index) => ({
      id: `routine:${index}`,
      kind: "routine" as const,
      routineId: `routine-${index}`,
      name: `Unique routine ${index}`,
      status: "active",
      href: `routine://routine-${index}`,
      aliases: [`routine:Unique routine ${index}`, `Unique routine ${index}`, `routine-${index}`],
    }));
    const suggestions = createEditorSlashSuggestions(() => routines);
    const props = {
      editor: {} as never,
      query: "",
      signal: new AbortController().signal,
    };

    const openItems = await suggestions(props);
    const searchedItems = await suggestions({ ...props, query: "Unique routine 99" });

    expect(openItems).toHaveLength(50);
    expect(searchedItems.some((item) => item.id === "routine:99")).toBe(true);
  });
});
