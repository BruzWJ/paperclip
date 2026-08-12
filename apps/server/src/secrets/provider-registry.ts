import type {
  SecretProvider,
  SecretProviderDescriptor,
} from "@paperclipai/shared";
import { awsSecretsManagerProvider } from "./aws-secrets-manager-provider.js";
import { createLocalEncryptedProvider } from "./local-encrypted-provider.js";
import {
  gcpSecretManagerProvider,
  vaultProvider,
} from "./external-stub-providers.js";
import type {
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretsRuntimeConfig,
} from "./types.js";
import { unprocessable } from "../errors.js";

export interface SecretProviderRegistry {
  get(id: SecretProvider): SecretProviderModule;
  list(): SecretProviderDescriptor[];
  check(): Promise<SecretProviderHealthCheck[]>;
}

export function createSecretProviderRegistry(
  config: SecretsRuntimeConfig,
): SecretProviderRegistry {
  const providers: SecretProviderModule[] = [
    createLocalEncryptedProvider(config),
    awsSecretsManagerProvider,
    gcpSecretManagerProvider,
    vaultProvider,
  ];
  const providerById = new Map<SecretProvider, SecretProviderModule>(
    providers.map((provider) => [provider.id, provider]),
  );

  return {
    get(id) {
      const provider = providerById.get(id);
      if (!provider) throw unprocessable(`Unsupported secret provider: ${id}`);
      return provider;
    },
    list() {
      return providers.map((provider) => provider.descriptor());
    },
    check() {
      return Promise.all(providers.map((provider) => provider.healthCheck()));
    },
  };
}
