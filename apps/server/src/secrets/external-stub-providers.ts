import { unprocessable } from "../errors.js";
import type { PreparedSecretVersion, SecretProviderModule } from "./types.js";
import { createHash } from "node:crypto";

function unavailableProvider(
  id: "gcp_secret_manager" | "vault",
  label: string,
): SecretProviderModule {
  function externalFingerprint(
    externalRef: string,
    providerVersionRef: string | null,
  ): string {
    return createHash("sha256")
      .update(`${id}:${externalRef}:${providerVersionRef ?? ""}`)
      .digest("hex");
  }

  function prepareExternalReference(input: {
    externalRef: string;
    providerVersionRef?: string | null;
  }): PreparedSecretVersion {
    if (
      input.externalRef.length === 0 ||
      input.externalRef.trim() !== input.externalRef
    ) {
      throw unprocessable(
        "Provider secret reference must be a non-empty exact value without surrounding whitespace",
      );
    }
    if (
      input.providerVersionRef != null &&
      (input.providerVersionRef.length === 0 ||
        input.providerVersionRef.trim() !== input.providerVersionRef)
    ) {
      throw unprocessable(
        "Provider secret version reference must be a non-empty exact value without surrounding whitespace",
      );
    }
    const externalRef = input.externalRef;
    const providerVersionRef = input.providerVersionRef ?? null;
    const fingerprint = externalFingerprint(externalRef, providerVersionRef);
    return {
      material: {
        scheme: "external_reference_v1",
        provider: id,
        externalRef,
        providerVersionRef,
      },
      valueSha256: fingerprint,
      fingerprintSha256: fingerprint,
      externalRef,
      providerVersionRef,
    };
  }

  return {
    id,
    descriptor() {
      return {
        id,
        label,
        requiresExternalRef: true,
        supportsManagedValues: false,
        supportsExternalReferences: true,
        configured: false,
      };
    },
    async validateConfig() {
      return {
        ok: false,
        warnings: [`${id} provider is not configured in this deployment`],
      };
    },
    async createSecret() {
      throw unprocessable(
        `${id} provider is not configured for Paperclip-managed values`,
      );
    },
    async createVersion() {
      throw unprocessable(
        `${id} provider is not configured for Paperclip-managed values`,
      );
    },
    async linkExternalSecret(input) {
      return prepareExternalReference(input);
    },
    async resolveVersion() {
      throw unprocessable(
        `${id} provider is not configured in this deployment`,
      );
    },
    async deleteOrArchive() {
      // External references are metadata-only in Paperclip for unconfigured providers.
    },
    async healthCheck() {
      return {
        provider: id,
        status: "warn",
        message: `${id} provider is available for external references but not configured for runtime resolution`,
        warnings: [
          "Linked external references can be stored as metadata, but runtime resolution will fail until this provider is configured.",
        ],
      };
    },
  };
}

export const gcpSecretManagerProvider = unavailableProvider(
  "gcp_secret_manager",
  "GCP Secret Manager",
);
export const vaultProvider = unavailableProvider("vault", "HashiCorp Vault");
