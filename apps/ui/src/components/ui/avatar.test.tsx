// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, AvatarFallback, AvatarGroupCount, AvatarImage } from "./avatar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Avatar", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLDivElement[] = [];

  afterEach(() => {
    for (const root of roots) flushSync(() => root.unmount());
    for (const container of containers) container.remove();
    roots.length = 0;
    containers.length = 0;
  });

  it("uses one semi-rounded silhouette for the container, image, and fallback", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    containers.push(container);
    roots.push(root);
    document.body.appendChild(container);

    flushSync(() => {
      root.render(
        <Avatar>
          <AvatarImage src="/avatar.png" alt="Example user" />
          <AvatarFallback>EU</AvatarFallback>
        </Avatar>,
      );
    });

    const avatar = container.querySelector<HTMLElement>('[data-slot="avatar"]');
    const fallback = container.querySelector<HTMLElement>('[data-slot="avatar-fallback"]');

    expect(avatar?.className).toContain("rounded-md");
    expect(avatar?.className).not.toContain("rounded-full");
    expect(avatar?.className).toContain("overflow-hidden");
    expect(fallback?.className).toContain("rounded-md");
    expect(fallback?.className).not.toContain("rounded-full");
  });

  it("keeps avatar overflow counts on the same semi-rounded shape", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    containers.push(container);
    roots.push(root);
    document.body.appendChild(container);

    flushSync(() => root.render(<AvatarGroupCount>+3</AvatarGroupCount>));

    const count = container.querySelector<HTMLElement>('[data-slot="avatar-group-count"]');
    expect(count?.className).toContain("rounded-md");
    expect(count?.className).not.toContain("rounded-full");
  });
});
