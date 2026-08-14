// @vitest-environment jsdom

import { TestRouter as TestRouterComponent } from "@/test/TestRouter";
import { getRouteComponent } from "@/test/route-component";
import { SidebarProvider } from "@/components/ui/sidebar";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  RemoteSecretImportPreviewResult,
  SecretProviderConfigDiscoveryPreviewResult,
  SecretProviderDescriptor,
  UserSecretCoverageSummary,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import { ProviderVaultsTab as ProviderVaultsTabComponent, Route } from ".";

export const Secrets = getRouteComponent(Route);

export function TestRouter(props: ComponentProps<typeof TestRouterComponent>) {
  return <TestRouterComponent {...props} />;
}

export function ProviderVaultsTab(props: ComponentProps<typeof ProviderVaultsTabComponent>) {
  return (
    <SidebarProvider>
      <ProviderVaultsTabComponent {...props} />
    </SidebarProvider>
  );
}

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  providers: vi.fn(),
  providerHealth: vi.fn(),
  providerConfigs: vi.fn(),
  providerConfigDiscoveryPreview: vi.fn(),
  createProviderConfig: vi.fn(),
  updateProviderConfig: vi.fn(),
  disableProviderConfig: vi.fn(),
  removeProviderConfig: vi.fn(),
  setDefaultProviderConfig: vi.fn(),
  checkProviderConfigHealth: vi.fn(),
  remoteImportPreview: vi.fn(),
  remoteImport: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  rotate: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  usage: vi.fn(),
  accessEvents: vi.fn(),
  listUserSecretDefinitions: vi.fn(),
  createUserSecretDefinition: vi.fn(),
  updateUserSecretDefinition: vi.fn(),
  removeUserSecretDefinition: vi.fn(),
  userSecretDefinitionCoverage: vi.fn(),
  listUserSecrets: vi.fn(),
  createUserSecret: vi.fn(),
  rotateUserSecret: vi.fn(),
  removeUserSecret: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("@/hooks/useCurrentUserId", () => ({
  useCurrentUserId: () => "user-1",
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockPushToast,
    info: mockPushToast,
    success: mockPushToast,
    warning: mockPushToast,
  },
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export const providers: SecretProviderDescriptor[] = [
  {
    id: "local_encrypted",
    label: "Local encrypted",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: false,
    configured: true,
  },
  {
    id: "aws_secrets_manager",
    label: "AWS Secrets Manager",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: true,
    configured: true,
  },
  {
    id: "gcp_secret_manager",
    label: "GCP Secret Manager",
    requiresExternalRef: false,
    supportsManagedValues: false,
    supportsExternalReferences: true,
    configured: false,
  },
  {
    id: "vault",
    label: "Vault",
    requiresExternalRef: false,
    supportsManagedValues: false,
    supportsExternalReferences: true,
    configured: false,
  },
];

export const providerConfigs = [
  {
    id: "vault-local",
    provider: "local_encrypted",
    displayName: "Local default",
    status: "ready",
    isDefault: true,
    healthStatus: "ready",
    healthCheckedAt: null,
    healthMessage: null,
    healthDetails: null,
  },
  {
    id: "vault-aws",
    provider: "aws_secrets_manager",
    displayName: "AWS production",
    status: "ready",
    isDefault: false,
    healthStatus: null,
    healthCheckedAt: null,
    healthMessage: null,
    healthDetails: null,
  },
] satisfies Partial<CompanySecretProviderConfig>[];

export async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

export async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

export async function waitForReact(predicate: () => boolean, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushReact();
  }
  throw new Error("Timed out waiting for React state to settle");
}

export function makeDiscoveryPreview(
  overrides: Partial<SecretProviderConfigDiscoveryPreviewResult> = {},
): SecretProviderConfigDiscoveryPreviewResult {
  return {
    provider: "aws_secrets_manager",
    nextToken: null,
    sampledSecretCount: 2,
    skippedForeignPaperclipSampleCount: 0,
    warnings: [],
    candidates: [
      {
        provider: "aws_secrets_manager",
        displayName: "AWS production",
        config: {
          region: "us-east-1",
          namespace: "prod-use1",
          secretNamePrefix: "paperclip",
          kmsKeyId: "alias/paperclip-secrets",
          ownerTag: "platform",
          environmentTag: "production",
        },
        sampleCount: 2,
        samples: [
          {
            name: "paperclip/prod-use1/11111111-1111-4111-8111-111111111111/openai",
            hasKmsKey: true,
            tagKeys: ["owner", "environment"],
          },
        ],
        signals: {
          namespace: "prod-use1",
          secretNamePrefix: "paperclip",
          environmentTag: "production",
          ownerTag: "platform",
          kmsKeyId: "alias/paperclip-secrets",
          hasKmsKey: true,
          sampleCount: 2,
          paperclipManagedSampleCount: 0,
          skippedForeignPaperclipSampleCount: 0,
        },
        warnings: [],
      },
    ],
    ...overrides,
  };
}

export function makeRemoteImportPreview(
  overrides: Partial<RemoteSecretImportPreviewResult> = {},
): RemoteSecretImportPreviewResult {
  return {
    providerConfigId: "vault-aws",
    provider: "aws_secrets_manager",
    nextToken: null,
    candidates: [],
    ...overrides,
  };
}

export function makeCompanySecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "secret-openai",
    companyId: "11111111-1111-4111-8111-111111111111",
    scope: "company",
    ownerUserId: null,
    userSecretDefinitionId: null,
    key: "openai_api_key",
    name: "OPENAI_API_KEY",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    referenceCount: 2,
    createdAt: new Date("2026-05-06T00:00:00.000Z"),
    updatedAt: new Date("2026-05-06T00:00:00.000Z"),
    ...overrides,
  };
}

export function makeUserSecretDefinition(
  overrides: Partial<UserSecretDefinition> = {},
): UserSecretDefinition {
  return {
    id: "def-github",
    companyId: "11111111-1111-4111-8111-111111111111",
    key: "PERSONAL_GH_TOKEN",
    name: "Personal GitHub token",
    description: "Used when the responsible user's own repos must be reached.",
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: "Create a fine-grained PAT with repo read access.",
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    deletedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  };
}

export const userSecretCoverage: UserSecretCoverageSummary = {
  definitionId: "def-github",
  configuredCount: 3,
  missingCount: 2,
  inactiveCount: 0,
};

export function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function selectRadixOption(trigger: HTMLElement, optionText: string) {
  await act(async () => {
    trigger.click();
  });
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
    el.textContent?.trim().startsWith(optionText),
  );
  expect(option, `radix option "${optionText}" not found`).toBeTruthy();
  await act(async () => {
    (option as HTMLElement).click();
  });
}

export async function openAwsVaultDialog() {
  const vaultTabButton = [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Provider vaults"),
  ) as HTMLButtonElement | undefined;
  await act(async () => {
    vaultTabButton?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    vaultTabButton?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    vaultTabButton?.click();
  });
  await flushReact();

  const addVaultButtons = [...document.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("Add vault"),
  ) as HTMLButtonElement[];
  await act(async () => {
    addVaultButtons[1]?.click();
  });
  await flushReact();
}

export function setupSecretsPageTest() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mockSecretsApi.list.mockResolvedValue([]);
  mockSecretsApi.providers.mockResolvedValue(providers);
  mockSecretsApi.providerHealth.mockResolvedValue({
    providers: [
      {
        provider: "local_encrypted",
        status: "warn",
        message: "Local encrypted provider has a warning.",
        warnings: ["Backup reminder"],
      },
    ],
  });
  mockSecretsApi.providerConfigs.mockResolvedValue(providerConfigs);
  mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValue(makeDiscoveryPreview());
  mockSecretsApi.remoteImportPreview.mockResolvedValue(makeRemoteImportPreview());
  mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([]);
  mockSecretsApi.userSecretDefinitionCoverage.mockResolvedValue(userSecretCoverage);
  mockSecretsApi.listUserSecrets.mockResolvedValue([]);
  return {
    container,
    cleanup: () => {
      container.remove();
      document.body.innerHTML = "";
      vi.clearAllMocks();
    },
  };
}

export async function renderSecretsPage(
  container: HTMLElement,
  path = "/11111111-1111-4111-8111-111111111111/company/settings/secrets",
) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <TestRouter initialEntries={[path]}>
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <Secrets />
          </SidebarProvider>
        </QueryClientProvider>
      </TestRouter>,
    );
  });
  await flushReact();
  await flushReact();
  return { root, queryClient };
}

export function useMockSecretsApiTestState() {
  return mockSecretsApi;
}

export function useMockSetBreadcrumbsTestState() {
  return mockSetBreadcrumbs;
}

export function useMockPushToastTestState() {
  return mockPushToast;
}
