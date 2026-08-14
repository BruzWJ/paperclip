// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecretBindingPicker } from "./SecretBindingPicker";

const mockSecretsApi = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("@/hooks/useCompanyRouteId", () => ({ useCompanyRouteId: () => "company-1" }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
HTMLElement.prototype.scrollIntoView ??= () => {};

function secret(id: string, overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id,
    companyId: "company-1",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: id,
    name: id,
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SecretBindingPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.resetAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    document.body.replaceChildren();
  });

  async function renderPicker(element: React.ReactElement) {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
    });
    await flush();
  }

  it("uses the Kibo secret picker while preserving a fixed version on entity changes", async () => {
    mockSecretsApi.list.mockResolvedValue([
      secret("secret-1", { name: "FIRST_TOKEN" }),
      secret("secret-2", { name: "SECOND_TOKEN" }),
    ]);
    const onChange = vi.fn();
    await renderPicker(
      <SecretBindingPicker value={{ secretId: "secret-1", version: 2 }} onChange={onChange} />,
    );

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Secret"]');
    expect(trigger?.textContent).toContain("FIRST_TOKEN");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Version"]')?.textContent).toContain(
      "v2",
    );

    await act(async () => trigger?.focus());
    await flush();
    const second = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) =>
      item.textContent?.includes("SECOND_TOKEN"),
    );
    expect(second).not.toBeUndefined();
    await act(async () => second?.click());

    expect(onChange).toHaveBeenCalledWith({ secretId: "secret-2", version: 2 });
  });

  it("creates and binds through the shared FormDialog creation contract", async () => {
    mockSecretsApi.list.mockResolvedValue([]);
    mockSecretsApi.create.mockResolvedValue(secret("created", { name: "NEW_TOKEN" }));
    const onChange = vi.fn();
    await renderPicker(<SecretBindingPicker value={null} onChange={onChange} />);

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Secret"]');
    await act(async () => trigger?.focus());
    await flush();
    const createItem = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) =>
      item.textContent?.includes("Create new secret"),
    );
    await act(async () => createItem?.click());
    await flush();

    const name = document.querySelector<HTMLInputElement>("#secret-name");
    const value = document.querySelector<HTMLTextAreaElement>("#secret-value");
    expect(name).not.toBeNull();
    expect(value).not.toBeNull();
    await setInput(name!, "NEW_TOKEN");
    await setInput(value!, "super-secret");

    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Create & bind"),
    );
    await act(async () => submit?.click());
    await flush();

    expect(mockSecretsApi.create).toHaveBeenCalledWith("company-1", {
      name: "NEW_TOKEN",
      value: "super-secret",
      description: null,
    });
    expect(onChange).toHaveBeenCalledWith({ secretId: "created", version: "latest" });
  });

  it("keeps statusFilter=null selectable instead of applying SecretPicker's active-only default", async () => {
    mockSecretsApi.list.mockResolvedValue([
      secret("archived-secret", { name: "ARCHIVED_TOKEN", status: "archived" }),
    ]);
    const onChange = vi.fn();
    await renderPicker(<SecretBindingPicker value={null} onChange={onChange} statusFilter={null} />);

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Secret"]');
    await act(async () => trigger?.focus());
    await flush();
    const archived = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) =>
      item.textContent?.includes("ARCHIVED_TOKEN"),
    );
    expect(archived?.getAttribute("data-disabled")).not.toBe("true");
    await act(async () => archived?.click());

    expect(onChange).toHaveBeenCalledWith({ secretId: "archived-secret", version: "latest" });
  });
});
