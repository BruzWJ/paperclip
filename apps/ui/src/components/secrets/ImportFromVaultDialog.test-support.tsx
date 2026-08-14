// @vitest-environment jsdom

import type {
  CompanySecretProviderConfig,
  RemoteSecretImportCandidate,
  RemoteSecretImportPreviewResult,
} from "@paperclipai/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, type ComponentProps } from "react";
import { vi } from "vitest";

const mockSecretsApi = vi.hoisted(() => ({
  remoteImportPreview: vi.fn(),
  remoteImport: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockPushToast,
    success: mockPushToast,
    warning: mockPushToast,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { ImportFromVaultDialog as ImportFromVaultDialogComponent } from "./ImportFromVaultDialog";

export function ImportFromVaultDialog(props: ComponentProps<typeof ImportFromVaultDialogComponent>) {
  return <ImportFromVaultDialogComponent {...props} />;
}

export const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

export const awsVault: CompanySecretProviderConfig = {
  id: "vault-aws",
  companyId: COMPANY_ID,
  provider: "aws_secrets_manager",
  displayName: "AWS production",
  status: "ready",
  isDefault: true,
  config: { region: "us-east-1" },
  healthStatus: null,
  healthCheckedAt: null,
  healthMessage: null,
  healthDetails: null,
  disabledAt: null,
  createdByAgentId: null,
  createdByUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function makeCandidate(
  overrides: Partial<RemoteSecretImportCandidate> = {},
): RemoteSecretImportCandidate {
  return {
    externalRef: "arn:aws:secretsmanager:us-east-1:1:secret:prod/foo-AbCdEf",
    remoteName: "prod/foo",
    name: "prod/foo",
    key: "prod-foo",
    providerVersionRef: null,
    providerMetadata: { name: "prod/foo" },
    status: "ready",
    importable: true,
    conflicts: [],
    ...overrides,
  };
}

export function makePreview(
  candidates: RemoteSecretImportCandidate[],
  nextToken: string | null = null,
): RemoteSecretImportPreviewResult {
  return {
    providerConfigId: awsVault.id,
    provider: "aws_secrets_manager",
    nextToken,
    candidates,
  };
}

export async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

export async function flushDebounce() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 300));
  });
}

export function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { queryClient };
}

export function useMockSecretsApiTestState() {
  return mockSecretsApi;
}

export function useMockPushToastTestState() {
  return mockPushToast;
}
