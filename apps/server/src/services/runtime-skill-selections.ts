import {
  agentAdapterConfigRevisions,
  agents,
  type Db,
} from "@paperclipai/db";
import {
  agentAdapterAcpConfigurationSchema,
  parseCompanySkillPins,
  type AgentAdapterAcpConfiguration,
  type CompanySkillPin,
} from "@paperclipai/shared";
import { and, asc, eq } from "drizzle-orm";

export function skillVersionSelectionMap(
  entries: readonly CompanySkillPin[],
) {
  return new Map(entries.map((entry) => [entry.key, entry.versionId] as const));
}

function canonicalAcpConfiguration(
  value: unknown,
): AgentAdapterAcpConfiguration {
  const parsed = agentAdapterAcpConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Agent current adapter revision has an invalid immutable ACP configuration",
    );
  }
  return parsed.data;
}

export async function companySkillPinsForAgent(
  db: Pick<Db, "select">,
  companyId: string,
  agentId: string,
): Promise<CompanySkillPin[]> {
  const current = await db
    .select({
      currentAdapterConfigRevisionId:
        agents.currentAdapterConfigRevisionId,
      revisionId: agentAdapterConfigRevisions.id,
      acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
    })
    .from(agents)
    .leftJoin(
      agentAdapterConfigRevisions,
      and(
        eq(
          agentAdapterConfigRevisions.id,
          agents.currentAdapterConfigRevisionId,
        ),
        eq(agentAdapterConfigRevisions.companyId, agents.companyId),
        eq(agentAdapterConfigRevisions.agentId, agents.id),
      ),
    )
    .where(
      and(eq(agents.companyId, companyId), eq(agents.id, agentId)),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!current?.currentAdapterConfigRevisionId) return [];
  if (
    current.revisionId
    !== current.currentAdapterConfigRevisionId
  ) {
    throw new Error(
      "Agent current adapter configuration revision is invalid",
    );
  }
  return parseCompanySkillPins(
    canonicalAcpConfiguration(current.acpConfiguration).companySkillPins,
  );
}

export async function companySkillPinsForCompany(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<Array<CompanySkillPin & { agentId: string }>> {
  const rows = await db
    .select({
      agentId: agents.id,
      currentAdapterConfigRevisionId:
        agents.currentAdapterConfigRevisionId,
      revisionId: agentAdapterConfigRevisions.id,
      acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
    })
    .from(agents)
    .leftJoin(
      agentAdapterConfigRevisions,
      and(
        eq(
          agentAdapterConfigRevisions.id,
          agents.currentAdapterConfigRevisionId,
        ),
        eq(agentAdapterConfigRevisions.companyId, agents.companyId),
        eq(agentAdapterConfigRevisions.agentId, agents.id),
      ),
    )
    .where(eq(agents.companyId, companyId))
    .orderBy(asc(agents.id));
  return rows.flatMap((row) => {
    if (!row.currentAdapterConfigRevisionId) return [];
    if (
      row.revisionId
      !== row.currentAdapterConfigRevisionId
    ) {
      throw new Error(
        "Agent current adapter configuration revision is invalid",
      );
    }
    return parseCompanySkillPins(
      canonicalAcpConfiguration(row.acpConfiguration).companySkillPins,
    ).map((pin) => ({
      agentId: row.agentId,
      ...pin,
    }));
  });
}
