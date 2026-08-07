import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentCompanyToolSelections } from "../schema/tool_access.js";
import { externalObjectMentions } from "../schema/external_object_mentions.js";
import { externalObjects } from "../schema/external_objects.js";
import { issueComments } from "../schema/issue_comments.js";
import { pluginWithdrawalOperations } from "../schema/issue_creator_edge.js";
import { pluginCompanySettings } from "../schema/plugin_company_settings.js";
import { pluginConfig } from "../schema/plugin_config.js";
import {
  pluginDatabaseNamespaces,
  pluginMigrations,
} from "../schema/plugin_database.js";
import { pluginEntities } from "../schema/plugin_entities.js";
import { pluginJobRuns, pluginJobs } from "../schema/plugin_jobs.js";
import { pluginLogs } from "../schema/plugin_logs.js";
import { pluginManagedResources } from "../schema/plugin_managed_resources.js";
import { plugins } from "../schema/plugins.js";
import {
  pluginRunContexts,
  runInterfaceToolCalls,
} from "../schema/run_interface_foundation.js";
import { pluginState } from "../schema/plugin_state.js";
import { pluginWebhookDeliveries } from "../schema/plugin_webhooks.js";
import { secretAccessEvents } from "../schema/secret_access_events.js";

type Table = Parameters<typeof getTableConfig>[0];

function pluginForeignKeys(table: Table) {
  return getTableConfig(table).foreignKeys.filter((foreignKey) =>
    foreignKey.reference().foreignTable === plugins
  );
}

describe("terminal plugin uninstall schema", () => {
  it("cascades every installation-owned operational row", () => {
    const operationalTables = [
      pluginCompanySettings,
      pluginConfig,
      pluginDatabaseNamespaces,
      pluginEntities,
      pluginJobRuns,
      pluginJobs,
      pluginLogs,
      pluginManagedResources,
      pluginMigrations,
      pluginRunContexts,
      pluginState,
      pluginWebhookDeliveries,
    ];

    for (const table of operationalTables) {
      const foreignKeys = pluginForeignKeys(table);
      expect(foreignKeys, getTableConfig(table).name).toHaveLength(1);
      expect(foreignKeys[0]?.onDelete, getTableConfig(table).name).toBe(
        "cascade",
      );
    }
  });

  it("clears optional external provenance without retaining an installation", () => {
    for (const table of [
      externalObjects,
      externalObjectMentions,
      secretAccessEvents,
    ]) {
      const foreignKeys = pluginForeignKeys(table);
      expect(foreignKeys, getTableConfig(table).name).toHaveLength(1);
      expect(foreignKeys[0]?.onDelete, getTableConfig(table).name).toBe(
        "set null",
      );
    }
  });

  it("keeps historical actor identities as bare UUID values", () => {
    for (const table of [
      issueComments,
      pluginWithdrawalOperations,
      runInterfaceToolCalls,
      agentCompanyToolSelections,
    ]) {
      expect(pluginForeignKeys(table), getTableConfig(table).name).toEqual([]);
    }
  });
});
