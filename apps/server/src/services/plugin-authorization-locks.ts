import {
  companies,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";

export interface PluginCompanySettingLockInput {
  pluginInstallationId: string;
  companyId: string;
}

export interface PluginCompanySettingLockScope {
  installation: typeof plugins.$inferSelect | null;
  company: typeof companies.$inferSelect | null;
  companySetting: typeof pluginCompanySettings.$inferSelect | null;
}

/**
 * Shared serialization prefix for company-setting writes and plugin issue
 * owner mutations:
 *
 *   installation -> company -> plugin_company_settings
 *
 * A company row is locked even when the setting row is absent. That makes an
 * absent setting serializable with a concurrent first insert. Callers that
 * need agent ownership then acquire company agents and their exact current
 * revisions after this helper returns.
 */
export async function lockPluginCompanySettingScopeInTransaction(
  tx: IssueSessionDbTransaction,
  input: PluginCompanySettingLockInput,
): Promise<PluginCompanySettingLockScope> {
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

  const companySetting = await tx
    .select()
    .from(pluginCompanySettings)
    .where(
      and(
        eq(
          pluginCompanySettings.pluginId,
          input.pluginInstallationId,
        ),
        eq(pluginCompanySettings.companyId, input.companyId),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);

  return { installation, company, companySetting };
}
