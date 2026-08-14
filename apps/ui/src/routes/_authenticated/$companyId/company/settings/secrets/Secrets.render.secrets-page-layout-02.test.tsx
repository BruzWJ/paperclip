// @vitest-environment jsdom
import { ApiError } from "@/api/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  flushReact,
  makeDiscoveryPreview,
  makeUserSecretDefinition,
  openAwsVaultDialog,
  renderSecretsPage,
  selectRadixOption,
  setInputValue,
  setTextareaValue,
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
  it("opens the New secret dialog when provider queries fail", async () => {
    mockSecretsApi.providers.mockRejectedValueOnce(new ApiError("Providers unavailable", 403, null));
    mockSecretsApi.providerConfigs.mockRejectedValueOnce(
      new ApiError("Provider vaults unavailable", 403, null),
    );
    const { root } = await renderSecretsPage(container);
    const newSecretButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New secret"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();
    expect(document.body.textContent).toContain("Create secret");
    expect(document.body.textContent).toContain("Select a provider.");
    await act(async () => {
      root.unmount();
    });
  });
  it("opens the each-user detail sheet with coverage and set-my-value actions", async () => {
    const definition = makeUserSecretDefinition();
    mockSecretsApi.listUserSecretDefinitions.mockResolvedValue([definition]);
    mockSecretsApi.listUserSecrets.mockResolvedValue([{ definition, secret: null }]);
    const { root } = await renderSecretsPage(container);
    const definitionRowOpen = container.querySelector<HTMLButtonElement>(
      '[data-testid="secrets-card-view"] button[aria-label="Open secret Personal GitHub token"]',
    );
    expect(definitionRowOpen).not.toBeNull();
    await act(async () => {
      definitionRowOpen?.click();
    });
    await flushReact();
    expect(document.body.textContent).toContain("Personal GitHub token");
    expect(document.body.textContent).toContain("Details");
    expect(document.body.textContent).toContain("Coverage");
    expect(document.body.textContent).toContain("Usage");
    expect(document.body.textContent).toContain("Access events");
    const viewCoverageButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("View in Coverage"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      viewCoverageButton?.click();
    });
    await flushReact();
    expect(document.body.textContent).toContain("3 of 5 set");
    expect(document.body.textContent).toContain("Secret values are never shown here");
    const setValueButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Set my value"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      setValueButton?.click();
    });
    await flushReact();
    expect(document.body.textContent).toContain("Set your value");
    expect(document.body.textContent).toContain("PERSONAL_GH_TOKEN");
    await act(async () => {
      root.unmount();
    });
  });
  it("keeps the new secret value textarea width-constrained for long tokens", async () => {
    const { root } = await renderSecretsPage(container);
    const newSecretButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New secret"),
    ) as HTMLButtonElement | undefined;
    expect(newSecretButton).toBeDefined();
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();
    const secretValueTextarea = document.body.querySelector(
      "#new-secret-value",
    ) as HTMLTextAreaElement | null;
    expect(secretValueTextarea).not.toBeNull();
    expect(secretValueTextarea?.className).toContain("min-w-0");
    expect(secretValueTextarea?.className).toContain("overflow-x-hidden");
    expect(secretValueTextarea?.className).toContain("break-all");
    await act(async () => {
      root.unmount();
    });
  });
  it("explains AWS managed secret creation failures with actionable safe details", async () => {
    const rawProviderMessage =
      "AccessDeniedException: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized";
    mockSecretsApi.create.mockRejectedValueOnce(
      new ApiError(
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        403,
        {
          details: {
            code: "access_denied",
            provider: "aws_secrets_manager",
            operation: "secret.create",
            providerConfigId: "vault-aws",
            region: "us-east-1",
            credentialPath: "Paperclip server runtime/provider credential path",
            requiredCapability: "secretsmanager:CreateSecret",
            actionableMessage:
              "AWS managed secret creation needs secretsmanager:CreateSecret in the selected region for this provider vault.",
            safeAlternative:
              "If the secret already exists in AWS, link it as an external reference instead of creating a Paperclip-managed value.",
          },
        },
      ),
    );
    const { root } = await renderSecretsPage(container);
    const newSecretButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New secret"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();
    await act(async () => {
      setInputValue(document.getElementById("new-secret-name") as HTMLInputElement, "AWS test token");
      setTextareaValue(document.getElementById("new-secret-value") as HTMLTextAreaElement, "secret-value");
    });
    await selectRadixOption(
      document.getElementById("new-secret-provider") as HTMLElement,
      "AWS Secrets Manager",
    );
    await flushReact();
    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create secret",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      createButton?.click();
    });
    await flushReact();
    await flushReact();
    const errorBanner = document.querySelector('[data-testid="secret-create-error"]');
    expect(errorBanner?.textContent).toContain("AWS secret creation needs CreateSecret permission");
    expect(errorBanner?.textContent).toContain("secretsmanager:CreateSecret");
    expect(errorBanner?.textContent).toContain("us-east-1");
    expect(errorBanner?.textContent).toContain("link it as an external reference");
    expect(errorBanner?.textContent).toContain("vault-aws");
    expect(errorBanner?.textContent).not.toContain(rawProviderMessage);
    expect(errorBanner?.textContent).not.toContain("123456789012");
    await act(async () => {
      root.unmount();
    });
  });
  it("renders generic secret creation failures with a stable selector", async () => {
    mockSecretsApi.create.mockRejectedValueOnce(new ApiError("Secret creation failed", 500, null));
    const { root } = await renderSecretsPage(container);
    const newSecretButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("New secret"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      newSecretButton?.click();
    });
    await flushReact();
    await act(async () => {
      setInputValue(document.getElementById("new-secret-name") as HTMLInputElement, "Failed token");
      setTextareaValue(document.getElementById("new-secret-value") as HTMLTextAreaElement, "secret-value");
    });
    await flushReact();
    const createButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Create secret",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      createButton?.click();
    });
    await flushReact();
    await flushReact();
    const errorBanner = document.querySelector('[data-testid="secret-create-error"]');
    expect(errorBanner?.textContent).toContain("Secret creation failed");
    await act(async () => {
      root.unmount();
    });
  });
  it("discovers AWS provider vault candidates and applies selected values as prefill", async () => {
    mockSecretsApi.providerConfigDiscoveryPreview.mockResolvedValueOnce(makeDiscoveryPreview());
    const { root } = await renderSecretsPage(container);
    await openAwsVaultDialog();
    const discoveryButton = document.querySelector(
      '[data-testid="aws-vault-discovery-button"]',
    ) as HTMLButtonElement | null;
    expect(discoveryButton).not.toBeNull();
    expect(discoveryButton?.disabled).toBe(true);
    const regionInput = document.getElementById("provider-vault-aws-region") as HTMLInputElement | null;
    const prefixInput = document.getElementById(
      "provider-vault-secret-name-prefix",
    ) as HTMLInputElement | null;
    expect(regionInput).not.toBeNull();
    await act(async () => {
      setInputValue(regionInput!, "us-east-1");
      setInputValue(prefixInput!, "paperclip");
    });
    await flushReact();
    expect(discoveryButton?.disabled).toBe(false);
    await act(async () => {
      discoveryButton?.click();
    });
    await flushReact();
    await flushReact();
    expect(mockSecretsApi.providerConfigDiscoveryPreview).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          namespace: null,
          secretNamePrefix: "paperclip",
          kmsKeyId: null,
          ownerTag: null,
          environmentTag: null,
        },
        query: "paperclip",
        pageSize: 25,
      },
    );
    expect(document.body.textContent).toContain("AWS production");
    const useValuesButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Use values"),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      useValuesButton?.click();
    });
    await flushReact();
    expect((document.getElementById("vault-name") as HTMLInputElement).value).toBe("AWS production");
    expect((document.getElementById("provider-vault-namespace") as HTMLInputElement).value).toBe("prod-use1");
    expect((document.getElementById("provider-vault-secret-name-prefix") as HTMLInputElement).value).toBe(
      "paperclip",
    );
    expect((document.getElementById("provider-vault-kms-key-id") as HTMLInputElement).value).toBe(
      "alias/paperclip-secrets",
    );
    expect((document.getElementById("provider-vault-owner-tag") as HTMLInputElement).value).toBe("platform");
    expect((document.getElementById("provider-vault-environment-tag") as HTMLInputElement).value).toBe(
      "production",
    );
    expect(mockSecretsApi.createProviderConfig).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});
