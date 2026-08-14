import { type HostServices, requireExactPluginScopeId } from "@paperclipai/plugin-sdk";
import { sql } from "drizzle-orm";
import {
  assertConfiguredLocalFolder,
  assertWritableConfiguredLocalFolder,
  deletePluginLocalFolderFile,
  inspectPluginLocalFolder,
  listPluginLocalFolderEntries,
  prepareAndInspectPluginLocalFolder,
  preparePluginLocalFolder,
  readPluginLocalFolderText,
  setStoredLocalFolder,
  writePluginLocalFolderTextAtomic,
} from "./plugin-local-folders.js";
import { logger } from "../middleware/logger.js";
import { badRequest } from "../errors.js";
import {
  executePinnedHttpRequest,
  PLUGIN_FETCH_TIMEOUT_MS,
  validateAndResolveFetchUrl,
} from "./plugin-host-networking.js";
import type { PluginHostServicesScope } from "./plugin-host-services-context.js";

export function createPluginHostServicesMethods1(scope: PluginHostServicesScope) {
  const {
    db,
    pluginId,
    options,
    pluginKey,
    registry,
    stateStore,
    pluginDb,
    scopedBus,
    toPluginEntityRecord,
    ensureCompanyId,
    ensurePluginAvailableForCompany,
    deliverSubscribedEvent,
    getLocalFolderDeclaration,
    getStoredLocalFolderConfig,
    inspectStoredLocalFolder,
  } = scope;

  return {
    config: {
      async get() {
        const configRow = await registry.getConfig(pluginId);
        return configRow?.configJson ?? {};
      },
    },

    localFolders: {
      async configure(params) {
        if (
          typeof params !== "object" ||
          params === null ||
          Array.isArray(params) ||
          Object.keys(params).some((key) => key !== "companyId" && key !== "folderKey" && key !== "path") ||
          typeof params.path !== "string" ||
          params.path.length === 0 ||
          params.path.trim() !== params.path
        ) {
          throw badRequest(
            "Local folder configuration accepts only companyId, folderKey, and a non-empty path",
          );
        }
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const declaration = getLocalFolderDeclaration(params.folderKey);
        const existing = await registry.getCompanySettings(pluginId, companyId);
        const status = await prepareAndInspectPluginLocalFolder({
          declaration,
          path: params.path,
        });

        const nextSettings = setStoredLocalFolder(existing?.settingsJson, params.folderKey, params.path);
        await registry.upsertCompanySettings(pluginId, companyId, {
          settingsJson: nextSettings,
        });
        return status;
      },

      async status(params) {
        return inspectStoredLocalFolder(params.companyId, params.folderKey);
      },

      async list(params) {
        const status = await inspectStoredLocalFolder(params.companyId, params.folderKey);
        assertConfiguredLocalFolder(status);
        const listing = await listPluginLocalFolderEntries(status.realPath!, {
          relativePath: params.relativePath,
          recursive: params.recursive,
          maxEntries: params.maxEntries,
        });
        return { ...listing, folderKey: params.folderKey };
      },

      async readText(params) {
        const status = await inspectStoredLocalFolder(params.companyId, params.folderKey);
        assertConfiguredLocalFolder(status);
        return readPluginLocalFolderText(status.realPath!, params.relativePath);
      },

      async writeTextAtomic(params) {
        const companyId = ensureCompanyId(params.companyId);
        const declaration = getLocalFolderDeclaration(params.folderKey);
        const stored = await getStoredLocalFolderConfig(companyId, params.folderKey);
        if (stored) {
          await preparePluginLocalFolder({
            declaration,
            path: stored.path,
          });
        }
        const status = await inspectPluginLocalFolder({
          declaration,
          path: stored?.path ?? null,
        });
        assertWritableConfiguredLocalFolder(status);
        await writePluginLocalFolderTextAtomic(status.realPath!, params.relativePath, params.contents);
        return inspectPluginLocalFolder({ declaration, path: stored!.path });
      },

      async deleteFile(params) {
        const companyId = ensureCompanyId(params.companyId);
        const declaration = getLocalFolderDeclaration(params.folderKey);
        const stored = await getStoredLocalFolderConfig(companyId, params.folderKey);
        const status = await inspectPluginLocalFolder({
          declaration,
          path: stored?.path ?? null,
        });
        assertWritableConfiguredLocalFolder(status);
        await deletePluginLocalFolderFile(status.realPath!, params.relativePath);
        return inspectPluginLocalFolder({ declaration, path: stored!.path });
      },
    },

    state: {
      async get(params) {
        const scopeId = requireExactPluginScopeId(params.scopeKind, params.scopeId);
        if (params.scopeKind === "company") await ensurePluginAvailableForCompany(scopeId!);
        return stateStore.get(pluginId, params.scopeKind, params.stateKey, {
          scopeId: scopeId ?? undefined,
          namespace: params.namespace,
        });
      },
      async set(params) {
        const scopeId = requireExactPluginScopeId(params.scopeKind, params.scopeId);
        if (params.scopeKind === "company") await ensurePluginAvailableForCompany(scopeId!);
        await stateStore.set(pluginId, params);
      },
      async delete(params) {
        const scopeId = requireExactPluginScopeId(params.scopeKind, params.scopeId);
        if (params.scopeKind === "company") await ensurePluginAvailableForCompany(scopeId!);
        await stateStore.delete(pluginId, params.scopeKind, params.stateKey, {
          scopeId: scopeId ?? undefined,
          namespace: params.namespace,
        });
      },
    },

    db: {
      async query(params) {
        return pluginDb.query(pluginId, params.sql, params.params);
      },
      async execute(params) {
        return pluginDb.execute(pluginId, params.sql, params.params);
      },
    },

    entities: {
      async upsert(params) {
        const scopeId = requireExactPluginScopeId(params.scopeKind, params.scopeId);
        const companyId = params.scopeKind === "company" ? scopeId : null;
        if (companyId) await ensurePluginAvailableForCompany(companyId);
        const entity = await registry.upsertEntity(pluginId, {
          ...params,
          companyId,
        });
        return toPluginEntityRecord(entity);
      },
      async list(params) {
        if (params.scopeId !== undefined && params.scopeKind === undefined) {
          throw new Error("Plugin entity scopeId requires scopeKind");
        }
        if (params.scopeKind !== undefined) {
          const scopeId = requireExactPluginScopeId(params.scopeKind, params.scopeId);
          if (params.scopeKind === "company") await ensurePluginAvailableForCompany(scopeId!);
        }
        const entities = await registry.listEntities(pluginId, params);
        return entities.map(toPluginEntityRecord);
      },
    },

    events: {
      async emit(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const { errors } = await scopedBus.emit(params.name, companyId, params.payload);
        for (const { pluginKey: subscriberPluginKey, error } of errors) {
          logger.warn(
            {
              pluginKey: subscriberPluginKey,
              sourcePluginId: pluginId,
              eventName: params.name,
              err: error,
            },
            "plugin event handler failed",
          );
        }
      },
      async subscribe(params) {
        if (params.filter) {
          scopedBus.subscribe(params.eventPattern, params.filter, deliverSubscribedEvent);
        } else {
          scopedBus.subscribe(params.eventPattern, deliverSubscribedEvent);
        }
      },
    },

    http: {
      async fetch(params) {
        // SSRF protection: validate protocol whitelist + block private IPs.
        // Resolve once, then connect directly to that IP to prevent DNS rebinding.
        const target = await validateAndResolveFetchUrl(params.url, {
          allowPrivateNetwork: options.manifest.capabilities.includes("http.private-network"),
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PLUGIN_FETCH_TIMEOUT_MS);

        try {
          const init = params.init as RequestInit | undefined;
          return await executePinnedHttpRequest(target, init, controller.signal);
        } finally {
          clearTimeout(timeout);
        }
      },
    },
  } satisfies Pick<
    HostServices & { dispose(): Promise<void> },
    "config" | "localFolders" | "state" | "db" | "entities" | "events" | "http"
  >;
}
