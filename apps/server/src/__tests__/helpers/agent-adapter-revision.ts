import { deriveAgentAdapterConfigRevision } from "../../services/agent-adapter-config-revisions.js";
import { resolveAcpAdapterRevisionConfiguration } from "@paperclipai/adapter-utils";
import {
  CANONICAL_TEST_ADAPTER_DEFINITION,
  CANONICAL_TEST_ADAPTER_TYPE,
  canonicalTestAdapterConfig,
} from "./adapter-implementation.js";

/**
 * Produces the complete closed ACP revision payload used by PostgreSQL
 * fixtures. Keeping this on the production derivation path prevents tests
 * from recreating retired provider/session revision shapes.
 */
export function canonicalTestAgentAdapterRevision() {
  return deriveAgentAdapterConfigRevision({
    acpConfiguration: resolveAcpAdapterRevisionConfiguration({
      adapter: {
        type: CANONICAL_TEST_ADAPTER_TYPE,
        definition: CANONICAL_TEST_ADAPTER_DEFINITION,
      },
      config: canonicalTestAdapterConfig(),
    }),
  });
}
