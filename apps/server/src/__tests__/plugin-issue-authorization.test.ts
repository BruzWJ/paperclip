import {
  agentAdapterConfigRevisions,
  agents,
  companies,
  pluginCompanySettings,
  plugins,
  type Db,
} from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import {
  resolveInvokableIssueOwnerCatalog,
  type InvokableIssueOwnerAgent,
  type InvokableIssueOwnerRevision,
} from "../services/agent-invokability.js";
import type { IssueSessionDbTransaction } from "../services/issue-session/event-store.js";
import {
  lockPluginInstallationCompanyScopeInTransaction,
} from "../services/plugin-authorization-locks.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  assertPluginInstallationRequestScope,
  assertPluginPermittedIssueOwnerInTransaction,
  PluginIssueAuthorizationRejected,
  resolvePluginPermittedIssueOwnerCatalog,
  selectPluginPermittedIssueOwner,
} from "../services/plugin-issue-authorization.js";

const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "00000000-0000-4000-8000-000000000002";
const PLUGIN_KEY = "example.plugin";

function installation(
  overrides: Partial<typeof plugins.$inferSelect> = {},
): typeof plugins.$inferSelect {
  return {
    id: INSTALLATION_ID,
    pluginKey: PLUGIN_KEY,
    status: "ready",
    manifestJson: {
      id: PLUGIN_KEY,
      capabilities: ["issues.create"],
    },
    ...overrides,
  } as typeof plugins.$inferSelect;
}

function company(): typeof companies.$inferSelect {
  return {
    id: COMPANY_ID,
  } as typeof companies.$inferSelect;
}

function setting(
  settingsJson: Record<string, unknown> = {},
): typeof pluginCompanySettings.$inferSelect {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    companyId: COMPANY_ID,
    pluginId: INSTALLATION_ID,
    settingsJson,
  } as typeof pluginCompanySettings.$inferSelect;
}

function canonicalInvokableCatalog() {
  const agents: InvokableIssueOwnerAgent[] = [
    {
      id: "00000000-0000-4000-8000-000000000010",
      companyId: COMPANY_ID,
      name: "Ready",
      reportsTo: null,
      status: "active",
      currentAdapterConfigRevisionId:
        "00000000-0000-4000-8000-000000000020",
    },
    {
      id: "00000000-0000-4000-8000-000000000011",
      companyId: COMPANY_ID,
      name: "Paused",
      reportsTo: null,
      status: "paused",
      currentAdapterConfigRevisionId:
        "00000000-0000-4000-8000-000000000021",
    },
    {
      id: "00000000-0000-4000-8000-000000000012",
      companyId: COMPANY_ID,
      name: "Missing current revision",
      reportsTo: null,
      status: "active",
      currentAdapterConfigRevisionId:
        "00000000-0000-4000-8000-000000000022",
    },
  ];
  const revisions: InvokableIssueOwnerRevision[] = [
    {
      id: "00000000-0000-4000-8000-000000000020",
      companyId: COMPANY_ID,
      agentId: agents[0]!.id,
    },
    {
      id: "00000000-0000-4000-8000-000000000021",
      companyId: COMPANY_ID,
      agentId: agents[1]!.id,
    },
  ];
  return resolveInvokableIssueOwnerCatalog({
    companyId: COMPANY_ID,
    companyAgents: agents,
    adapterRevisions: revisions,
  });
}

function resolve(
  overrides: Partial<
    Parameters<typeof resolvePluginPermittedIssueOwnerCatalog>[0]
  > = {},
) {
  return resolvePluginPermittedIssueOwnerCatalog({
    companyId: COMPANY_ID,
    pluginInstallationId: INSTALLATION_ID,
    pluginKey: PLUGIN_KEY,
    operation: "issues.create",
    installation: installation(),
    company: company(),
    invokableOwnerCatalog: canonicalInvokableCatalog(),
    ...overrides,
  });
}

describe("plugin issue owner authorization", () => {
  it("intersects approved create permission with canonical company-wide invokability and current revisions", () => {
    const catalog = resolve();

    expect([...catalog.keys()]).toEqual([
      "00000000-0000-4000-8000-000000000010",
    ]);
    expect(
      catalog.get("00000000-0000-4000-8000-000000000010"),
    ).toMatchObject({
      owner: { name: "Ready" },
      revisionId: "00000000-0000-4000-8000-000000000020",
    });
    expect(() =>
      selectPluginPermittedIssueOwner(catalog, {
        companyId: COMPANY_ID,
        pluginInstallationId: INSTALLATION_ID,
        pluginKey: PLUGIN_KEY,
        operation: "issues.create",
        ownerAgentId: "00000000-0000-4000-8000-000000000011",
      }),
    ).toThrowError(
      expect.objectContaining({
        reason: "plugin_owner_not_permitted",
      }),
    );
  });

  it("uses the persisted manifest capability for the exact operation", () => {
    expect(() => resolve({ operation: "issues.update" })).toThrowError(
      expect.objectContaining({
        code: "plugin_issue_authorization_rejected",
        reason: "plugin_operation_not_approved",
      }),
    );

    expect(
      resolve({
        operation: "issues.update",
        installation: installation({
          manifestJson: {
            id: PLUGIN_KEY,
            capabilities: ["issues.update"],
          } as (typeof plugins.$inferSelect)["manifestJson"],
        }),
      }).size,
    ).toBe(1);
  });

  it("uses instance installation and company availability for the plugin host read-side gate", async () => {
    const rows = new Map<unknown, unknown[]>([
      [plugins, [installation()]],
      [companies, [company()]],
    ]);
    const db = {
      select() {
        return {
          from(table: unknown) {
            return {
              where() {
                return Promise.resolve(rows.get(table) ?? []);
              },
            };
          },
        };
      },
    } as unknown as Db;

    await expect(assertPluginInstallationRequestScope(db, {
      companyId: COMPANY_ID,
      pluginInstallationId: INSTALLATION_ID,
      pluginKey: PLUGIN_KEY,
    })).resolves.toMatchObject({ id: INSTALLATION_ID });
  });

  it.each([
    {
      name: "missing installation",
      overrides: { installation: null },
      reason: "plugin_installation_missing",
    },
    {
      name: "wrong installation key",
      overrides: {
        installation: installation({ pluginKey: "other.plugin" }),
      },
      reason: "plugin_installation_identity_mismatch",
    },
    {
      name: "wrong persisted manifest identity",
      overrides: {
        installation: installation({
          manifestJson: {
            id: "other.plugin",
            capabilities: ["issues.create"],
          } as (typeof plugins.$inferSelect)["manifestJson"],
        }),
      },
      reason: "plugin_installation_identity_mismatch",
    },
    {
      name: "non-ready installation",
      overrides: { installation: installation({ status: "disabled" }) },
      reason: "plugin_installation_not_ready",
    },
    {
      name: "missing company",
      overrides: { company: null },
      reason: "plugin_company_missing",
    },
  ])("rejects $name", ({ overrides, reason }) => {
    try {
      resolve(overrides);
      throw new Error("Expected plugin authorization rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginIssueAuthorizationRejected);
      expect(error).toMatchObject({ reason });
    }
  });

  it("locks only the instance installation and target company for authorization", async () => {
    const lockOrder: unknown[] = [];
    const rows = new Map<unknown, unknown[]>([
      [plugins, [installation()]],
      [companies, [company()]],
    ]);
    const tx = {
      select() {
        return {
          from(table: unknown) {
            lockOrder.push(table);
            return {
              where() {
                return {
                  for() {
                    return Promise.resolve(rows.get(table) ?? []);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as IssueSessionDbTransaction;

    const scope = await lockPluginInstallationCompanyScopeInTransaction(tx, {
      pluginInstallationId: INSTALLATION_ID,
      companyId: COMPANY_ID,
    });

    expect(lockOrder).toEqual([
      plugins,
      companies,
    ]);
    expect(scope).toMatchObject({
      installation: { id: INSTALLATION_ID },
      company: { id: COMPANY_ID },
    });
  });

  it("uses the shared installation-company-setting prefix for company setting mutations", async () => {
    const lockOrder: unknown[] = [];
    const currentSetting = setting({ localFolders: {} });
    const updatedSetting = {
      ...currentSetting,
      settingsJson: { localFolders: { content: { path: "/tmp/content" } } },
    };
    const rows = new Map<unknown, unknown[]>([
      [plugins, [installation()]],
      [companies, [company()]],
      [pluginCompanySettings, [currentSetting]],
    ]);
    const tx = {
      select() {
        return {
          from(table: unknown) {
            lockOrder.push(table);
            return {
              where() {
                return {
                  for() {
                    return Promise.resolve(rows.get(table) ?? []);
                  },
                };
              },
            };
          },
        };
      },
      update(table: unknown) {
        expect(table).toBe(pluginCompanySettings);
        expect(lockOrder).toEqual([
          plugins,
          companies,
          pluginCompanySettings,
        ]);
        return {
          set() {
            return {
              where() {
                return {
                  returning() {
                    return Promise.resolve([updatedSetting]);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as IssueSessionDbTransaction;
    const db = {
      transaction<T>(
        callback: (transaction: IssueSessionDbTransaction) => Promise<T>,
      ) {
        return callback(tx);
      },
    } as unknown as Db;

    await expect(
      pluginRegistryService(db).upsertCompanySettings(
        INSTALLATION_ID,
        COMPANY_ID,
        {
          settingsJson: updatedSetting.settingsJson,
        },
      ),
    ).resolves.toEqual(updatedSetting);
  });

  it("locks and rechecks the complete requested-owner catalog in one transaction", async () => {
    const owner = {
      id: "00000000-0000-4000-8000-000000000010",
      companyId: COMPANY_ID,
      name: "Ready",
      reportsTo: null,
      status: "active",
      currentAdapterConfigRevisionId:
        "00000000-0000-4000-8000-000000000020",
    } as typeof agents.$inferSelect;
    const revision = {
      id: owner.currentAdapterConfigRevisionId,
      companyId: COMPANY_ID,
      agentId: owner.id,
    } as typeof agentAdapterConfigRevisions.$inferSelect;
    const lockOrder: unknown[] = [];
    const rows = new Map<unknown, unknown[]>([
      [plugins, [installation()]],
      [companies, [company()]],
      [agents, [owner]],
      [agentAdapterConfigRevisions, [revision]],
    ]);
    const tx = {
      select() {
        return {
          from(table: unknown) {
            lockOrder.push(table);
            const chain = {
              where() {
                return chain;
              },
              orderBy() {
                return chain;
              },
              for() {
                return Promise.resolve(rows.get(table) ?? []);
              },
            };
            return chain;
          },
        };
      },
    } as unknown as IssueSessionDbTransaction;

    await expect(
      assertPluginPermittedIssueOwnerInTransaction(tx, {
        companyId: COMPANY_ID,
        pluginInstallationId: INSTALLATION_ID,
        pluginKey: PLUGIN_KEY,
        operation: "issues.create",
        ownerAgentId: owner.id,
      }),
    ).resolves.toMatchObject({
      owner: { id: owner.id },
      revisionId: revision.id,
    });
    expect(lockOrder).toEqual([
      plugins,
      companies,
      agents,
      agentAdapterConfigRevisions,
    ]);
  });
});
