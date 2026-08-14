// @vitest-environment jsdom
import { ApiError } from "@/api/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  flushReact,
  makeDiscoveryPreview,
  openAwsVaultDialog,
  renderSecretsPage,
  setInputValue,
  setupSecretsPageTest,
  useMockSecretsApiTestState,
} from "./-Secrets-render-test-support";
const mockSecretsApi = useMockSecretsApiTestState();
describe("Secrets page layout", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupSecretsPageTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("shows AWS discovery errors without replacing manual vault form values", async () => {
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized";
    mockSecretsApi.providerConfigDiscoveryPreview.mockRejectedValueOnce(
      new ApiError(
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        403,
        {
          details: {
            code: "access_denied",
            provider: "aws_secrets_manager",
            operation: "secret_provider_config.discovery.preview",
            providerConfigId: "discovery-preview",
            providerVaultContext: "draft_config",
            region: "us-west-2",
            credentialPath: "Paperclip server runtime/provider credential path",
            requiredCapability: "secretsmanager:ListSecrets",
            actionableMessage:
              "AWS discovery preview needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.",
            safeAlternative:
              "If the operator already knows the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required.",
          },
        },
      ),
    );
    const { root } = await renderSecretsPage(container);
    await openAwsVaultDialog();
    const regionInput = document.getElementById("provider-vault-aws-region") as HTMLInputElement;
    const namespaceInput = document.getElementById("provider-vault-namespace") as HTMLInputElement;
    await act(async () => {
      setInputValue(regionInput, "us-west-2");
      setInputValue(namespaceInput, "manual-prod");
    });
    await flushReact();
    const discoveryButton = document.querySelector(
      '[data-testid="aws-vault-discovery-button"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      discoveryButton?.click();
    });
    await flushReact();
    await flushReact();
    const errorBanner = document.querySelector('[data-testid="aws-vault-discovery-error"]');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain("AWS discovery needs ListSecrets permission");
    expect(errorBanner?.textContent).toContain("secretsmanager:ListSecrets");
    expect(errorBanner?.textContent).toContain("Paperclip server runtime/provider credential path");
    expect(errorBanner?.textContent).toContain("paste/link that ARN");
    expect(errorBanner?.textContent).toContain("DescribeSecret");
    expect(errorBanner?.textContent).toContain("us-west-2");
    expect(errorBanner?.textContent).toContain("secret_provider_config.discovery.preview");
    expect(errorBanner?.textContent).toContain("aws_secrets_manager");
    expect(errorBanner?.textContent).toContain("Safe request/error details");
    expect(errorBanner?.textContent).not.toContain(rawProviderMessage);
    expect(errorBanner?.textContent).not.toContain("arn:aws");
    expect(errorBanner?.textContent).not.toContain("123456789012");
    expect(regionInput.value).toBe("us-west-2");
    expect(namespaceInput.value).toBe("manual-prod");
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps generic AWS discovery 403 errors on the generic failure path", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockRejectedValueOnce(
      new ApiError("AWS discovery request failed before IAM evaluation.", 403, {
        details: {
          code: "proxy_forbidden",
          provider: "aws_secrets_manager",
          operation: "secret_provider_config.discovery.preview",
          region: "us-west-1",
        },
      }),
    );
    const { root } = await renderSecretsPage(container);
    await openAwsVaultDialog();
    const regionInput = document.getElementById("provider-vault-aws-region") as HTMLInputElement;
    await act(async () => {
      setInputValue(regionInput, "us-west-1");
    });
    await flushReact();
    await act(async () => {
      (
        document.querySelector('[data-testid="aws-vault-discovery-button"]') as HTMLButtonElement | null
      )?.click();
    });
    await flushReact();
    await flushReact();
    const errorBanner = document.querySelector('[data-testid="aws-vault-discovery-error"]');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain("AWS discovery failed");
    expect(errorBanner?.textContent).toContain("AWS discovery request failed before IAM evaluation.");
    expect(errorBanner?.textContent).toContain("proxy_forbidden");
    expect(errorBanner?.textContent).not.toContain("AWS discovery needs ListSecrets permission");
    await act(async () => {
      root.unmount();
    });
  });
  it("auto-generates the key from the name and keeps it read-only until Edit", async () => {
    const { root } = await renderSecretsPage(container);
    const newSecretButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New secret"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();
    const nameInput = document.getElementById("new-secret-name") as HTMLInputElement;
    const keyInput = document.getElementById("new-secret-key") as HTMLInputElement;
    const valueTextarea = document.getElementById("new-secret-value") as HTMLTextAreaElement;
    // Path-style placeholder and value directly after name for natural tab order.
    expect(nameInput.placeholder).toBe("/dev/foo/bar");
    expect(nameInput.compareDocumentPosition(valueTextarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(valueTextarea.compareDocumentPosition(keyInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keyInput.readOnly).toBe(true);
    await act(async () => {
      setInputValue(nameInput, "OpenAI API Key");
    });
    await flushReact();
    expect(keyInput.value).toBe("openai-api-key");
    const editKeyButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Edit",
    ) as HTMLButtonElement | undefined;
    expect(editKeyButton).toBeDefined();
    await act(async () => {
      editKeyButton?.click();
    });
    await flushReact();
    expect((document.getElementById("new-secret-key") as HTMLInputElement).readOnly).toBe(false);
    await act(async () => {
      setInputValue(document.getElementById("new-secret-key") as HTMLInputElement, "custom-key");
      setInputValue(nameInput, "OpenAI API Key v2");
    });
    await flushReact();
    // Once edited, the key stops following the name.
    expect((document.getElementById("new-secret-key") as HTMLInputElement).value).toBe("custom-key");
    await act(async () => {
      root.unmount();
    });
  });
  it("shows an empty AWS discovery result without blocking manual entry", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValueOnce(
      makeDiscoveryPreview({ candidates: [], sampledSecretCount: 0 }),
    );
    const { root } = await renderSecretsPage(container);
    await openAwsVaultDialog();
    const regionInput = document.getElementById("provider-vault-aws-region") as HTMLInputElement;
    await act(async () => {
      setInputValue(regionInput, "us-east-2");
    });
    await flushReact();
    await act(async () => {
      (
        document.querySelector('[data-testid="aws-vault-discovery-button"]') as HTMLButtonElement | null
      )?.click();
    });
    await flushReact();
    await flushReact();
    expect(document.body.textContent).toContain("No AWS vault metadata candidates found");
    expect(regionInput.value).toBe("us-east-2");
    await act(async () => {
      root.unmount();
    });
  });
});
