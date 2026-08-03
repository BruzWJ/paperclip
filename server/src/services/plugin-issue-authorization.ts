import {
  companies,
  pluginCompanySettings,
  plugins,
  type Db,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  resolveInvokableIssueOwnerCatalogFromDb,
  resolveInvokableIssueOwnerCatalogInTransaction,
  type InvokableIssueOwnerResolution,
} from "./agent-invokability.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import {
  lockPluginCompanySettingScopeInTransaction,
  type PluginCompanySettingLockScope,
} from "./plugin-authorization-locks.js";

export type PluginIssueOwnerOperation = "issues.create" | "issues.update";

export interface PluginIssueAuthorizationIdentity {
  companyId: string;
  pluginInstallationId: string;
  pluginKey: string;
}

export interface PluginIssueOwnerCatalogInput
  extends PluginIssueAuthorizationIdentity {
  operation: PluginIssueOwnerOperation;
  installation: typeof plugins.$inferSelect | null;
  company: typeof companies.$inferSelect | null;
  companySetting: typeof pluginCompanySettings.$inferSelect | null;
  invokableOwnerCatalog: ReadonlyMap<
    string,
    InvokableIssueOwnerResolution
  >;
}

export type PluginIssueAuthorizationRejectionReason =
  | "plugin_installation_missing"
  | "plugin_installation_identity_mismatch"
  | "plugin_installation_not_ready"
  | "plugin_operation_not_approved"
  | "plugin_company_missing"
  | "plugin_company_disabled"
  | "plugin_owner_not_permitted";

export class PluginIssueAuthorizationRejected extends Error {
  readonly code = "plugin_issue_authorization_rejected";

  constructor(
    message: string,
    readonly reason: PluginIssueAuthorizationRejectionReason,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PluginIssueAuthorizationRejected";
  }
}

function reject(
  reason: PluginIssueAuthorizationRejectionReason,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new PluginIssueAuthorizationRejected(message, reason, details);
}

function assertInstallationCompanyAvailability(
  input: PluginIssueAuthorizationIdentity & PluginCompanySettingLockScope,
): typeof plugins.$inferSelect {
  const { installation, company, companySetting } = input;
  if (!installation) {
    reject(
      "plugin_installation_missing",
      "Plugin installation is unavailable",
      { pluginInstallationId: input.pluginInstallationId },
    );
  }
  if (
    installation.id !== input.pluginInstallationId ||
    installation.pluginKey !== input.pluginKey ||
    installation.manifestJson.id !== input.pluginKey
  ) {
    reject(
      "plugin_installation_identity_mismatch",
      "Plugin installation identity does not match",
      {
        pluginInstallationId: input.pluginInstallationId,
        pluginKey: input.pluginKey,
      },
    );
  }
  if (installation.status !== "ready") {
    reject(
      "plugin_installation_not_ready",
      "Plugin installation is not ready",
      {
        pluginInstallationId: installation.id,
        pluginStatus: installation.status,
      },
    );
  }
  if (!company || company.id !== input.companyId) {
    reject(
      "plugin_company_missing",
      "Plugin company is unavailable",
      { companyId: input.companyId },
    );
  }
  if (
    companySetting &&
    (
      companySetting.pluginId !== installation.id ||
      companySetting.companyId !== company.id
    )
  ) {
    reject(
      "plugin_installation_identity_mismatch",
      "Plugin company setting identity does not match",
      {
        pluginInstallationId: installation.id,
        companyId: company.id,
      },
    );
  }
  // The persisted schema defines absence as enabled-by-default. An explicit
  // false is the sole company-level disable switch.
  if (companySetting?.enabled === false) {
    reject(
      "plugin_company_disabled",
      "Plugin is disabled for this company",
      {
        pluginInstallationId: installation.id,
        companyId: company.id,
      },
    );
  }
  return installation;
}

function assertPluginIssueOperationAvailability(
  input: PluginIssueAuthorizationIdentity &
    PluginCompanySettingLockScope & {
      operation: PluginIssueOwnerOperation;
    },
): typeof plugins.$inferSelect {
  const installation = assertInstallationCompanyAvailability(input);
  if (!installation.manifestJson.capabilities.includes(input.operation)) {
    reject(
      "plugin_operation_not_approved",
      "Plugin operation is not approved",
      {
        pluginInstallationId: installation.id,
        operation: input.operation,
      },
    );
  }
  return installation;
}

/**
 * Canonical operation-specific plugin owner catalog. The installation's
 * persisted, approved manifest capability gates the complete company-wide
 * canonical invokable-owner catalog; no org-position or generic-owner
 * fallback is added here.
 */
export function resolvePluginPermittedIssueOwnerCatalog(
  input: PluginIssueOwnerCatalogInput,
): ReadonlyMap<string, InvokableIssueOwnerResolution> {
  assertPluginIssueOperationAvailability(input);
  return new Map(input.invokableOwnerCatalog);
}

export function selectPluginPermittedIssueOwner(
  catalog: ReadonlyMap<string, InvokableIssueOwnerResolution>,
  input: PluginIssueAuthorizationIdentity & {
    operation: PluginIssueOwnerOperation;
    ownerAgentId: string;
  },
): InvokableIssueOwnerResolution {
  const owner = catalog.get(input.ownerAgentId);
  if (!owner) {
    reject(
      "plugin_owner_not_permitted",
      "Requested owner is not in the plugin-permitted issue owner catalog",
      {
        companyId: input.companyId,
        pluginInstallationId: input.pluginInstallationId,
        operation: input.operation,
        ownerAgentId: input.ownerAgentId,
      },
    );
  }
  return owner;
}

async function readInstallationCompanyAvailability(
  db: Db,
  input: PluginIssueAuthorizationIdentity,
): Promise<PluginCompanySettingLockScope> {
  const installation = await db
    .select()
    .from(plugins)
    .where(eq(plugins.id, input.pluginInstallationId))
    .then((rows) => rows[0] ?? null);
  const company = await db
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .then((rows) => rows[0] ?? null);
  const companySetting = await db
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
    .then((rows) => rows[0] ?? null);
  return { installation, company, companySetting };
}

/**
 * Read-side company availability check used by the plugin host before
 * dispatch. Mutations must still use the locked operation-specific resolver.
 */
export async function assertPluginInstallationAvailableForCompany(
  db: Db,
  input: PluginIssueAuthorizationIdentity,
): Promise<typeof plugins.$inferSelect> {
  return assertInstallationCompanyAvailability({
    ...input,
    ...(await readInstallationCompanyAvailability(db, input)),
  });
}

/** Resolves a descriptor/configuration-time catalog without write locks. */
export async function resolvePluginPermittedIssueOwnerCatalogFromDb(
  db: Db,
  input: PluginIssueAuthorizationIdentity & {
    operation: PluginIssueOwnerOperation;
  },
): Promise<ReadonlyMap<string, InvokableIssueOwnerResolution>> {
  const availability = await readInstallationCompanyAvailability(db, input);
  const invokableOwnerCatalog =
    await resolveInvokableIssueOwnerCatalogFromDb(db, {
      companyId: input.companyId,
    });
  return resolvePluginPermittedIssueOwnerCatalog({
    ...input,
    ...availability,
    invokableOwnerCatalog,
  });
}

/**
 * Mutation-time catalog resolver. This owns the exact lock order:
 *
 *   installation -> company -> setting -> agents -> current revisions
 */
export async function resolvePluginPermittedIssueOwnerCatalogInTransaction(
  tx: IssueSessionDbTransaction,
  input: PluginIssueAuthorizationIdentity & {
    operation: PluginIssueOwnerOperation;
  },
): Promise<ReadonlyMap<string, InvokableIssueOwnerResolution>> {
  const availability =
    await lockPluginCompanySettingScopeInTransaction(tx, input);
  // Reject an unavailable installation/company/capability before doing the
  // broader agent-graph lock, while retaining the same transaction boundary.
  assertPluginIssueOperationAvailability({ ...input, ...availability });
  const invokableOwnerCatalog =
    await resolveInvokableIssueOwnerCatalogInTransaction(tx, {
      companyId: input.companyId,
    });
  return resolvePluginPermittedIssueOwnerCatalog({
    ...input,
    ...availability,
    invokableOwnerCatalog,
  });
}

/**
 * Selects one requested owner strictly from the locked plugin-permitted
 * catalog. There is intentionally no generic invokability fallback.
 */
export async function assertPluginPermittedIssueOwnerInTransaction(
  tx: IssueSessionDbTransaction,
  input: PluginIssueAuthorizationIdentity & {
    operation: PluginIssueOwnerOperation;
    ownerAgentId: string;
  },
): Promise<InvokableIssueOwnerResolution> {
  const catalog =
    await resolvePluginPermittedIssueOwnerCatalogInTransaction(tx, input);
  return selectPluginPermittedIssueOwner(catalog, input);
}
