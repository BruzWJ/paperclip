import { describe, expect, it } from "vitest";
import { parseTaskArtifactFragment } from "./task-artifact-fragment";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("parseTaskArtifactFragment", () => {
  it.each([
    [`work-product-${ID}`, { kind: "work-product", id: ID }],
    [`attachment-${ID}`, { kind: "attachment", id: ID }],
  ])("parses the exact task artifact fragment %s", (fragment, expected) => {
    expect(parseTaskArtifactFragment(fragment)).toEqual(expected);
  });

  it.each([
    "",
    "attachment-art-1",
    `attachment-${ID.toUpperCase()}`,
    `attachment-%31${ID.slice(1)}`,
    `work-product-${ID}-extra`,
    `unknown-${ID}`,
  ])("rejects the noncanonical fragment %s", (fragment) => {
    expect(parseTaskArtifactFragment(fragment)).toBeNull();
  });
});
