import {
  agentAdapterConfigRevisions,
  agents,
  companies,
  pluginCompanySettings,
  plugins,
  type Db,
} from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import type { AdapterImplementationIdentity } from "@paperclipai/shared";

const ACP_ADAPTER_TYPE = "fixture-agent";
const ACP_IMPLEMENTATION_IDENTITY: AdapterImplementationIdentity = Object.freeze({
  adapterType: ACP_ADAPTER_TYPE,
  definitionVersion: "acpx-runtime/v1",
  protocolVersion: 1,
  origin: "builtin",
  packageName: "acpx",
  packageVersion: "test-runtime",
  buildIdentity: "acpx-test-runtime:fixture-agent",
  artifactDigest: "a".repeat(64),
});

vi.mock("../adapters/registry.js", () => ({
  isServerAdapterImplementationAvailable: (
    adapterType: string,
    identity: AdapterImplementationIdentity,
  ) =>
    adapterType === ACP_ADAPTER_TYPE &&
    identity.artifactDigest === ACP_IMPLEMENTATION_IDENTITY.artifactDigest,
}));
import {
  resolveInvokableIssueOwnerCatalog,
  type InvokableIssueOwnerAgent,
  type InvokableIssueOwnerRevision,
} from "../services/agent-invokability.js";
import type { IssueSessionDbTransaction } from "../services/issue-session/event-store.js";
import { lockPluginCompanySettingScopeInTransaction } from "../services/plugin-authorization-locks.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import {
  assertPluginInstallationAvailableForCompany,
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
  enabled: boolean,
): typeof pluginCompanySettings.$inferSelect {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    companyId: COMPANY_ID,
    pluginId: INSTALLATION_ID,
    enabled,
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
      adapterType: ACP_ADAPTER_TYPE,
      implementationIdentity: ACP_IMPLEMENTATION_IDENTITY,
      implementationAvailable: true,
    },
    {
      id: "00000000-0000-4000-8000-000000000021",
      companyId: COMPANY_ID,
      agentId: agents[1]!.id,
      adapterType: ACP_ADAPTER_TYPE,
      implementationIdentity: ACP_IMPLEMENTATION_IDENTITY,
      implementationAvailable: true,
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
    companySetting: null,
    invokableOwnerCatalog: canonicalInvokableCatalog(),
    ...overrides,
  });
}

describe("plugin issue owner authorization", () => {
  it("intersects approved create permission with canonical company-wide invokability and exact revision availability", () => {
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

  it("honors explicit company disable while preserving schema-defined absence-as-enabled", () => {
    expect(resolve({ companySetting: null }).size).toBe(1);
    expect(resolve({ companySetting: setting(true) }).size).toBe(1);
    expect(() =>
      resolve({ companySetting: setting(false) }),
    ).toThrowError(
      expect.objectContaining({
        reason: "plugin_company_disabled",
      }),
    );
  });

  it("uses persisted company availability for the plugin host read-side gate", async () => {
    const rows = new Map<unknown, unknown[]>([
      [plugins, [installation()]],
      [companies, [company()]],
      [pluginCompanySettings, [setting(false)]],
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

    await expect(
      assertPluginInstallationAvailableForCompany(db, {
        companyId: COMPANY_ID,
        pluginInstallationId: INSTALLATION_ID,
        pluginKey: PLUGIN_KEY,
      }),
    ).rejects.toMatchObject({
      reason: "plugin_company_disabled",
    });
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

  it("locks installation, company, then the exact setting row", async () => {
    const lockOrder: unknown[] = [];
    const rows = new Map<unknown, unknown[]>([
      [plugins, [installation()]],
      [companies, [company()]],
      [pluginCompanySettings, []],
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

    const scope = await lockPluginCompanySettingScopeInTransaction(tx, {
      pluginInstallationId: INSTALLATION_ID,
      companyId: COMPANY_ID,
    });

    expect(lockOrder).toEqual([
      plugins,
      companies,
      pluginCompanySettings,
    ]);
    expect(scope).toMatchObject({
      installation: { id: INSTALLATION_ID },
      company: { id: COMPANY_ID },
      companySetting: null,
    });
  });

  it("uses the shared installation-company-setting prefix for company setting mutations", async () => {
    const lockOrder: unknown[] = [];
    const currentSetting = setting(true);
    const updatedSetting = {
      ...currentSetting,
      enabled: false,
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
          enabled: false,
          settingsJson: {},
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
      adapterType: ACP_ADAPTER_TYPE,
      implementationIdentity: ACP_IMPLEMENTATION_IDENTITY,
    } as typeof agentAdapterConfigRevisions.$inferSelect;
    const lockOrder: unknown[] = [];
    const rows = new Map<unknown, unknown[]>([
      [plugins, [installation()]],
      [companies, [company()]],
      [pluginCompanySettings, [setting(true)]],
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
      pluginCompanySettings,
      agents,
      agentAdapterConfigRevisions,
    ]);
  });
});
