import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  deriveAgentAdapterConfigRevision,
  deriveAgentExecutionTargetDigest,
} from "../../services/agent-adapter-config-revisions.js";
import { environmentService } from "../../services/environments.js";
import {
  CANONICAL_TEST_ADAPTER_DEFINITION,
  CANONICAL_TEST_ADAPTER_IMPLEMENTATION_IDENTITY,
  CANONICAL_TEST_ADAPTER_TYPE,
  canonicalTestAdapterConfig,
} from "./adapter-implementation.js";

export async function bindTestAgentExecutionTarget(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
  },
) {
  const environment = await environmentService(db).ensureLocalEnvironment(
    input.companyId,
  );
  await db
    .update(agents)
    .set({
      adapterType: CANONICAL_TEST_ADAPTER_TYPE,
      adapterConfig: canonicalTestAdapterConfig(),
      defaultEnvironmentId: environment.id,
    })
    .where(
      and(
        eq(agents.companyId, input.companyId),
        eq(agents.id, input.agentId),
      ),
    );
  return {
    adapterType: CANONICAL_TEST_ADAPTER_TYPE,
    implementationIdentity: CANONICAL_TEST_ADAPTER_IMPLEMENTATION_IDENTITY,
    defaultEnvironmentId: environment.id,
    executionTargetDriver: environment.driver,
    executionTargetDigest: deriveAgentExecutionTargetDigest({
      environmentId: environment.id,
      driver: environment.driver,
      config: environment.config,
    }),
  };
}

/**
 * Produces the complete closed ACP revision payload used by PostgreSQL
 * fixtures. Keeping this on the production derivation path prevents tests
 * from recreating retired provider/session revision shapes.
 */
export function canonicalTestAgentAdapterRevision(
  executionTarget: Awaited<ReturnType<typeof bindTestAgentExecutionTarget>>,
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
    executionTarget: {
      environmentId: executionTarget.defaultEnvironmentId,
      driver: executionTarget.executionTargetDriver,
      digest: executionTarget.executionTargetDigest,
    },
    companySkillPins: companySkills.companySkillPins,
    skillChannel: companySkills.skillChannel,
    runtimeMetadata: {
      implementationIdentity:
        CANONICAL_TEST_ADAPTER_IMPLEMENTATION_IDENTITY,
      definition: CANONICAL_TEST_ADAPTER_DEFINITION,
    },
  });
}
