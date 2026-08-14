import { companies, pluginCompanySettings, plugins } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

interface PluginCompanySettingLockInput {
  pluginInstallationId: string;
  companyId: string;
}

export interface PluginInstallationCompanyLockScope {
  installation: typeof plugins.$inferSelect | null;
  company: typeof companies.$inferSelect | null;
}

interface PluginCompanySettingLockScope extends PluginInstallationCompanyLockScope {
  companySetting: typeof pluginCompanySettings.$inferSelect | null;
}

/** Lock the instance installation and target company in canonical order. */
export async function lockPluginInstallationCompanyScopeInTransaction(
  tx: TaskSessionDbTransaction,
  input: PluginCompanySettingLockInput,
): Promise<PluginInstallationCompanyLockScope> {
  const installation = await tx
    .select()
    .from(plugins)
    .where(eq(plugins.id, input.pluginInstallationId))
    .for("update")
    .then((rows) => rows[0] ?? null);

  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .for("update")
    .then((rows) => rows[0] ?? null);

  return { installation, company };
}

/**
 * Serialization scope for company-setting writes:
 *
 *   installation -> company -> plugin_company_settings
 *
 * A company row is locked even when the setting row is absent, so absence is
 * serialized with a concurrent first insert.
 */
export async function lockPluginCompanySettingScopeInTransaction(
  tx: TaskSessionDbTransaction,
  input: PluginCompanySettingLockInput,
): Promise<PluginCompanySettingLockScope> {
  const scope = await lockPluginInstallationCompanyScopeInTransaction(tx, input);

  const companySetting = await tx
    .select()
    .from(pluginCompanySettings)
    .where(
      and(
        eq(pluginCompanySettings.pluginId, input.pluginInstallationId),
        eq(pluginCompanySettings.companyId, input.companyId),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);

  return { ...scope, companySetting };
}
