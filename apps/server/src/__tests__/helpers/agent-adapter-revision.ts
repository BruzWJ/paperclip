import { deriveAgentAdapterConfigRevision } from "../../services/agent-adapter-config-revisions.js";
import {
  CANONICAL_TEST_ADAPTER_DEFINITION,
  CANONICAL_TEST_ADAPTER_IMPLEMENTATION_IDENTITY,
  CANONICAL_TEST_ADAPTER_TYPE,
  canonicalTestAdapterConfig,
} from "./adapter-implementation.js";

/**
 * Produces the complete closed ACP revision payload used by PostgreSQL
 * fixtures. Keeping this on the production derivation path prevents tests
 * from recreating retired provider/session revision shapes.
 */
export function canonicalTestAgentAdapterRevision(
  companySkills: {
    readonly companySkillPins: readonly {
      readonly key: string;
      readonly versionId: string;
    }[];
    readonly skillChannel: "isolated_skills_home" | "operator_native";
  } = {
    companySkillPins: [],
    skillChannel: "operator_native",
  },
) {
  return deriveAgentAdapterConfigRevision({
    adapterType: CANONICAL_TEST_ADAPTER_TYPE,
    adapterConfig: canonicalTestAdapterConfig(),
    companySkillPins: companySkills.companySkillPins,
    skillChannel: companySkills.skillChannel,
    runtimeMetadata: {
      implementationIdentity:
        CANONICAL_TEST_ADAPTER_IMPLEMENTATION_IDENTITY,
      definition: CANONICAL_TEST_ADAPTER_DEFINITION,
    },
  });
}
