import { describe, expect, it } from "vitest";
import { parseExactPublicOrigin } from "./public-origin.js";

describe("canonical public origin", () => {
  it("accepts an exact canonical HTTPS origin", () => {
    expect(parseExactPublicOrigin("https://paperclip.example")).toBe(
      "https://paperclip.example",
    );
  });

  it.each([
    "paperclip.example",
    "http://paperclip.example",
    "ftp://paperclip.example",
    "https://user:secret@paperclip.example",
    "https://@paperclip.example",
    "https://paperclip.example/subpath",
    "https://paperclip.example\\subpath",
    "https://paperclip.example/.",
    "https://paperclip.example/%2e",
    "https://paper\tclip.example",
    "https://paperclip.example?query=1",
    "https://paperclip.example?",
    "https://paperclip.example#fragment",
    "https://paperclip.example#",
    " HTTPS://Paperclip.Example:443/ ",
    "HTTPS://paperclip.example",
    "https://Paperclip.Example",
    "https://paperclip.example:443",
    "https://paperclip.example/",
  ])("rejects non-origin input %s", (value) => {
    expect(() => parseExactPublicOrigin(value)).toThrow(/Public origin/);
  });

  it("rejects HTTP rather than treating it as a public-origin warning", () => {
    expect(() => parseExactPublicOrigin("http://localhost:3100/")).toThrow(
      "Public origin must use https://",
    );
  });
});
