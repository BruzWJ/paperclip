// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGalleryModal, type GalleryMediaItem } from "./ImageGalleryModal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const textTracksDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "textTracks");
const audioTracksDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "audioTracks");
const textTrackLists = new WeakMap<HTMLMediaElement, EventTarget & { length: number }>();
const audioTrackLists = new WeakMap<HTMLMediaElement, EventTarget & { length: number }>();

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "textTracks", {
    configurable: true,
    get(this: HTMLMediaElement) {
      let tracks = textTrackLists.get(this);
      if (!tracks) {
        tracks = Object.assign(new EventTarget(), {
          length: 0,
          [Symbol.iterator]: () => [][Symbol.iterator](),
        });
        textTrackLists.set(this, tracks);
      }
      return tracks;
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
    configurable: true,
    get(this: HTMLMediaElement) {
      let tracks = audioTrackLists.get(this);
      if (!tracks) {
        tracks = Object.assign(new EventTarget(), {
          length: 0,
          [Symbol.iterator]: () => [][Symbol.iterator](),
        });
        audioTrackLists.set(this, tracks);
      }
      return tracks;
    },
  });
});

afterAll(() => {
  if (textTracksDescriptor) {
    Object.defineProperty(HTMLMediaElement.prototype, "textTracks", textTracksDescriptor);
  }
  if (audioTracksDescriptor) {
    Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", audioTracksDescriptor);
  }
});

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeMediaItem(overrides: Partial<GalleryMediaItem> = {}): GalleryMediaItem {
  return {
    id: "media-1",
    contentPath: "/api/attachments/media-1/content",
    openPath: "/api/attachments/media-1/content",
    downloadPath: "/api/attachments/media-1/content?download=1",
    contentType: "image/png",
    originalFilename: "screenshot.png",
    ...overrides,
  };
}

describe("ImageGalleryModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  it("renders video media with Kibo controls and a download link in the gallery", async () => {
    const video = makeMediaItem({
      id: "video-1",
      contentPath: "/api/attachments/video-1/content",
      downloadPath: "/api/attachments/video-1/content?download=1",
      contentType: "video/webm",
      originalFilename: "demo.webm",
    });

    await act(async () => {
      root.render(<ImageGalleryModal items={[video]} initialIndex={0} open onOpenChange={() => undefined} />);
    });
    await flushReact();

    const renderedVideo = document.body.querySelector("video");
    expect(document.body.querySelector("[data-reel-content]")).toBeTruthy();
    expect(document.body.querySelector("[data-reel-item]")).toBeTruthy();
    expect(renderedVideo?.getAttribute("src")).toBe("/api/attachments/video-1/content");
    expect(renderedVideo?.getAttribute("controls")).toBeNull();
    expect(document.body.querySelector('[data-slot="media-video-player"]')).toBeTruthy();
    expect(document.body.querySelector('[data-slot="media-video-player-controls"]')).toBeTruthy();
    expect(document.body.querySelector("media-play-button")).toBeTruthy();
    expect(document.body.querySelector("media-fullscreen-button")).toBeTruthy();
    expect(document.body.querySelector('a[aria-label="Download demo.webm"]')?.getAttribute("href")).toBe(
      "/api/attachments/video-1/content?download=1",
    );
  });

  it("supports keyboard navigation and Escape close", async () => {
    const onOpenChange = vi.fn();
    const first = makeMediaItem({
      id: "first",
      contentPath: "/api/attachments/first/content",
      originalFilename: "first.png",
    });
    const second = makeMediaItem({
      id: "second",
      contentPath: "/api/attachments/second/content",
      originalFilename: "second.png",
    });

    await act(async () => {
      root.render(
        <ImageGalleryModal items={[first, second]} initialIndex={0} open onOpenChange={onOpenChange} />,
      );
    });
    await flushReact();

    expect(document.body.textContent).toContain("first.png");
    expect(document.body.textContent).toContain("1 / 2");
    expect(document.body.querySelector("[data-rmiz]")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("second.png");
    expect(document.body.textContent).toContain("2 / 2");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("first.png");
    expect(document.body.textContent).toContain("1 / 2");

    await act(async () => {
      document.body
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
