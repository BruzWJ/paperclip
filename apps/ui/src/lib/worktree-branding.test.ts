// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { getWorktreeUiBranding } from "./worktree-branding";

function meta(name: string, content: string) {
  const element = document.createElement("meta");
  element.name = name;
  element.content = content;
  document.head.appendChild(element);
}

afterEach(() => {
  document.head.querySelectorAll('meta[name^="paperclip-worktree-"]').forEach((node) => node.remove());
});

describe("getWorktreeUiBranding", () => {
  it("remains visible for a worktree instance without consulting run-execution settings", () => {
    meta("paperclip-worktree-enabled", "true");
    meta("paperclip-worktree-name", "feature-local-only");
    meta("paperclip-worktree-color", "#336699");

    expect(getWorktreeUiBranding()).toMatchObject({
      enabled: true,
      name: "feature-local-only",
      color: "#336699",
    });
  });

  it("returns null outside a worktree instance", () => {
    expect(getWorktreeUiBranding()).toBeNull();
  });
});
