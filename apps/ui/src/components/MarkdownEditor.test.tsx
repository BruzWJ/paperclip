// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MarkdownEditor,
  act,
  computeMentionMenuPosition,
  createFileDragEvent,
  flush,
  setupMarkdownEditorTest,
  useMdxEditorMockStateTestState,
} from "./MarkdownEditor.test-support";

const mdxEditorMockState = useMdxEditorMockStateTestState();
describe("MarkdownEditor", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupMarkdownEditorTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("falls back to a raw textarea when the rich editor mounts into the placeholder without callbacks", async () => {
    mdxEditorMockState.emitMountSilentEmptyState = true;
    const handleChange = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Affected versions: <= v0.3.1"
          onChange={handleChange}
          placeholder="Add a description..."
        />,
      );
    });
    await flush();
    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("Affected versions: <= v0.3.1");
    expect(container.textContent).toContain("Rich editor unavailable for this markdown");
    expect(handleChange).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
  it("shows the editor-scoped dropzone by default when files are dragged over it", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={() => {}}
          placeholder="Markdown body"
          imageUploadHandler={async () => "https://example.com/image.png"}
        />,
      );
    });
    await flush();
    const scope = container.querySelector('[data-testid="mdx-editor"]')
      ?.parentElement as HTMLDivElement | null;
    expect(scope).not.toBeNull();
    await act(async () => {
      scope?.dispatchEvent(createFileDragEvent("dragenter"));
    });
    await flush();
    expect(scope?.className).toContain("ring-1");
    expect(container.textContent).toContain("Drop image to upload");
    await act(async () => {
      scope?.dispatchEvent(createFileDragEvent("dragleave"));
    });
    await flush();
    expect(scope?.className).not.toContain("ring-1");
    await act(async () => {
      root.unmount();
    });
  });
  it("defers file-drop visuals to a parent container when requested", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value=""
          onChange={() => {}}
          placeholder="Markdown body"
          imageUploadHandler={async () => "https://example.com/image.png"}
          fileDropTarget="parent"
        />,
      );
    });
    await flush();
    const scope = container.querySelector('[data-testid="mdx-editor"]')
      ?.parentElement as HTMLDivElement | null;
    expect(scope).not.toBeNull();
    act(() => {
      scope?.dispatchEvent(createFileDragEvent("dragenter"));
    });
    expect(scope?.className).not.toContain("ring-1");
    expect(container.textContent).not.toContain("Drop image to upload");
    await act(async () => {
      root.unmount();
    });
  });
  it("does not show the raw fallback while image-only markdown is settling", async () => {
    mdxEditorMockState.emitMountSilentEmptyState = true;
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value="![Screenshot](/api/attachments/image/content)"
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });
    await flush();
    await flush();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");
    await act(async () => {
      root.unmount();
    });
  });
  it("places the menu top on the caret line and offsets the left a space-width past the caret", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 100, viewportBottom: 118, viewportLeft: 240 },
        { offsetLeft: 0, offsetTop: 0, width: 800, height: 600 },
      ),
    ).toEqual({
      top: 100,
      left: 250,
    });
  });
  it("applies visual viewport offsets when present", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 20, viewportBottom: 38, viewportLeft: 120 },
        { offsetLeft: 24, offsetTop: 320, width: 320, height: 260 },
      ),
    ).toEqual({
      top: 340,
      left: 154,
    });
  });
  it("clamps the mention menu back into view near the viewport edges", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 260, viewportBottom: 278, viewportLeft: 240 },
        { offsetLeft: 0, offsetTop: 0, width: 280, height: 220 },
      ),
    ).toEqual({
      top: 12,
      left: 92,
    });
  });
  it("flips the menu above the caret line when it would overflow below", () => {
    expect(
      computeMentionMenuPosition(
        { viewportTop: 560, viewportBottom: 580, viewportLeft: 200 },
        { offsetLeft: 0, offsetTop: 0, width: 800, height: 600 },
      ),
    ).toEqual({
      top: 372,
      left: 210,
    });
  });
});

describe("MarkdownEditor", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupMarkdownEditorTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("applies async external value updates once the editor ref becomes ready", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownEditor value="" onChange={() => {}} placeholder="Markdown body" />);
    });
    await act(async () => {
      root.render(
        <MarkdownEditor value="Loaded plan body" onChange={() => {}} placeholder="Markdown body" />,
      );
    });
    await flush();
    expect(container.textContent).toContain("Loaded plan body");
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps the external value when the unfocused editor emits an empty mount reset", async () => {
    mdxEditorMockState.emitMountEmptyReset = true;
    const handleChange = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor value="Loaded plan body" onChange={handleChange} placeholder="Markdown body" />,
      );
    });
    await flush();
    expect(container.textContent).toContain("Loaded plan body");
    expect(handleChange).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
  it("does not recreate the mention decoration observer when the external value changes", async () => {
    const originalMutationObserver = globalThis.MutationObserver;
    class MockMutationObserver implements MutationObserver {
      static instances: MockMutationObserver[] = [];
      readonly observe = vi.fn();
      readonly disconnect = vi.fn();
      readonly takeRecords = vi.fn<() => MutationRecord[]>(() => []);
      constructor(readonly callback: MutationCallback) {
        MockMutationObserver.instances.push(this);
      }
    }
    vi.stubGlobal("MutationObserver", MockMutationObserver);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<MarkdownEditor value="First value" onChange={() => {}} placeholder="Markdown body" />);
      });
      await flush();
      const editable = container.querySelector('[contenteditable="true"]');
      expect(editable).not.toBeNull();
      const mentionObserverCountAfterInitialRender = MockMutationObserver.instances.filter((observer) =>
        observer.observe.mock.calls.some(([target]) => target === editable),
      ).length;
      await act(async () => {
        root.render(<MarkdownEditor value="Updated value" onChange={() => {}} placeholder="Markdown body" />);
      });
      await flush();
      // A separate rich-editor health observer is expected to recreate when the
      // controlled value changes. This assertion only covers the mention
      // decoration observer that attaches to the editable element itself.
      expect(
        MockMutationObserver.instances.filter((observer) =>
          observer.observe.mock.calls.some(([target]) => target === editable),
        ),
      ).toHaveLength(mentionObserverCountAfterInitialRender);
    } finally {
      await act(async () => {
        root.unmount();
      });
      vi.stubGlobal("MutationObserver", originalMutationObserver);
    }
  });
  it("converts advisory-style html image tags to markdown image syntax before mounting the editor", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value={`Before\n\n<img width="10" height="10" alt="image" src="https://example.com/test.png" />\n\nAfter`}
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });
    await flush();
    expect(mdxEditorMockState.markdownValues.at(-1)).toContain("![image](https://example.com/test.png)");
    expect(mdxEditorMockState.markdownValues.at(-1)).not.toContain("<img");
    expect(mdxEditorMockState.suppressHtmlProcessingValues).toContain(true);
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("After");
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps arbitrary HTML-like tags in the rich editor instead of falling back to raw source", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value={'<section data-source="paste">\n## My take\n\n<p>Benchmark notes</p>\n</section>'}
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });
    await flush();
    expect(mdxEditorMockState.suppressHtmlProcessingValues).toContain(true);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Benchmark notes");
    expect(container.textContent).not.toContain("Rich editor unavailable for this markdown");
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps scriptable pasted HTML inert in the rich editor", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value={
            '<script>fetch("/api/secrets")</script>\n<iframe src="https://example.com"></iframe>\n<p onclick="steal()">Plain text</p>'
          }
          onChange={() => {}}
          placeholder="Markdown body"
        />,
      );
    });
    await flush();
    expect(mdxEditorMockState.suppressHtmlProcessingValues).toContain(true);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("script, iframe, p[onclick]")).toBeNull();
    expect(container.textContent).toContain('fetch("/api/secrets")');
    expect(container.textContent).toContain("Plain text");
    await act(async () => {
      root.unmount();
    });
  });
  it("falls back to a raw textarea when the rich parser rejects the markdown", async () => {
    mdxEditorMockState.emitMountParseError = true;
    const handleChange = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value="Affected versions: <= v0.3.1"
          onChange={handleChange}
          placeholder="Markdown body"
        />,
      );
    });
    await flush();
    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe("Affected versions: <= v0.3.1");
    expect(container.textContent).toContain("Rich editor unavailable for this markdown");
    expect(handleChange).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
  it("falls back to a raw textarea when the rich editor crashes during render", async () => {
    mdxEditorMockState.throwOnRender = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const handleChange = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MarkdownEditor
          value="5. python3 circleback/sync_insights.py --input <tmp> -- writes insights/<group>/*.md"
          onChange={handleChange}
          placeholder="Markdown body"
        />,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector("textarea")).not.toBeNull();
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe(
      "5. python3 circleback/sync_insights.py --input <tmp> -- writes insights/<group>/*.md",
    );
    expect(container.textContent).toContain("Rich editor unavailable for this markdown");
    expect(consoleError).toHaveBeenCalledWith(
      "Markdown rich editor failed; falling back to raw textarea",
      expect.objectContaining({
        error: expect.any(Error),
        componentStack: expect.any(String),
      }),
    );
    consoleError.mockRestore();
    expect(handleChange).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});
