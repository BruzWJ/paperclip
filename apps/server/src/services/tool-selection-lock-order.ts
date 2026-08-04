import {
  plugins,
  toolApplications,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { and, asc, eq, inArray } from "drizzle-orm";

export type ToolSelectionLockTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Canonical row-lock order for the company-tool catalog and install substrate.
 *
 * Callers may acquire the stages incrementally as child ids become known, but
 * must never request a later stage before an earlier stage they also need.
 * Keeping install administration and runtime-agent selection on this owner
 * prevents create/configure races from taking the same rows in opposite order.
 */
export async function lockToolSelectionRowsInOrder(
  tx: ToolSelectionLockTransaction,
  input: {
    companyId: string;
    catalogEntryIds?: readonly string[];
    connectionIds?: readonly string[];
    applicationIds?: readonly string[];
    pluginInstallationIds?: readonly string[];
    installConnectionIds?: readonly string[];
  },
): Promise<void> {
  const catalogEntryIds = Array.from(
    new Set(input.catalogEntryIds ?? []),
  ).sort();
  const connectionIds = Array.from(
    new Set(input.connectionIds ?? []),
  ).sort();
  const applicationIds = Array.from(
    new Set(input.applicationIds ?? []),
  ).sort();
  const pluginInstallationIds = Array.from(
    new Set(input.pluginInstallationIds ?? []),
  ).sort();
  const installConnectionIds = Array.from(
    new Set(input.installConnectionIds ?? []),
  ).sort();

  if (catalogEntryIds.length > 0) {
    await tx
      .select({ id: toolCatalogEntries.id })
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.companyId, input.companyId),
          inArray(toolCatalogEntries.id, catalogEntryIds),
        ),
      )
      .orderBy(asc(toolCatalogEntries.id))
      .for("update");
  }
  if (connectionIds.length > 0) {
    await tx
      .select({ id: toolConnections.id })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, input.companyId),
          inArray(toolConnections.id, connectionIds),
        ),
      )
      .orderBy(asc(toolConnections.id))
      .for("update");
  }
  if (applicationIds.length > 0) {
    await tx
      .select({ id: toolApplications.id })
      .from(toolApplications)
      .where(
        and(
          eq(toolApplications.companyId, input.companyId),
          inArray(toolApplications.id, applicationIds),
        ),
      )
      .orderBy(asc(toolApplications.id))
      .for("update");
  }
  if (pluginInstallationIds.length > 0) {
    await tx
      .select({ id: plugins.id })
      .from(plugins)
      .where(inArray(plugins.id, pluginInstallationIds))
      .orderBy(asc(plugins.id))
      .for("update");
  }
  if (installConnectionIds.length > 0) {
    await tx
      .select({ id: toolConnectionInstalls.id })
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, input.companyId),
          inArray(
            toolConnectionInstalls.connectionId,
            installConnectionIds,
          ),
        ),
      )
      .orderBy(
        asc(toolConnectionInstalls.connectionId),
        asc(toolConnectionInstalls.targetType),
        asc(toolConnectionInstalls.targetAgentId),
        asc(toolConnectionInstalls.id),
      )
      .for("update");
  }
}
