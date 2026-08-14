import type { Db } from "@paperclipai/db";
import { logActivity } from "../services/index.js";

export type CompanyImportResult = {
  company: { id: string; action: unknown };
  agents: unknown[];
  warnings: unknown[];
};

export interface ImportedCompanyActivityContext {
  actorType: "user";
  actorId: string;
  include: unknown;
}

export function importedCompanyActivityContext(
  userId: string,
  include: unknown,
): ImportedCompanyActivityContext {
  return { actorType: "user", actorId: userId, include };
}

export async function logImportedCompanyActivity(
  db: Db,
  activity: ImportedCompanyActivityContext,
  result: CompanyImportResult,
) {
  await logActivity(db, {
    companyId: result.company.id,
    actorType: activity.actorType,
    actorId: activity.actorId,
    action: "company.imported",
    entityType: "company",
    entityId: result.company.id,
    details: {
      include: activity.include,
      agentCount: result.agents.length,
      warningCount: result.warnings.length,
      companyAction: result.company.action,
    },
  });
}
