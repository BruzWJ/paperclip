import type { AdapterImplementationIdentity } from "@paperclipai/shared";
import { findSelectableServerAdapterImplementation } from "../../adapters/registry.js";

export function selectableTestAdapterImplementationIdentity(
  adapterType: string,
): AdapterImplementationIdentity {
  const implementation =
    findSelectableServerAdapterImplementation(adapterType);
  if (!implementation) {
    throw new Error(
      `Test fixture requires a selectable ${adapterType} adapter implementation`,
    );
  }
  return implementation.identity;
}

export const CANONICAL_TEST_ADAPTER_TYPE = "codex";
export const CANONICAL_TEST_ADAPTER_IMPLEMENTATION_IDENTITY =
  selectableTestAdapterImplementationIdentity(CANONICAL_TEST_ADAPTER_TYPE);

export function canonicalTestAdapterConfig() {
  return { model: "gpt-5.6" };
}
