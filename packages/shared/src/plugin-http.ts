import type { PluginLogLevel } from "./constants.js";
import type {
  PluginConfig,
  PluginJobRecord,
  PluginJobRunRecord,
  PluginRecord,
} from "./types/plugin.js";

/** JSON representation of an installed plugin returned by the board API. */
export type PluginRecordDto = Omit<PluginRecord, "installedAt" | "updatedAt"> & {
  installedAt: string;
  updatedAt: string;
};

/** Detailed JSON representation returned by the plugin inspection endpoint. */
export type PluginDetailDto = PluginRecordDto & {
  supportsConfigTest: boolean;
};

/** JSON representation of an installed plugin's instance configuration. */
export type PluginConfigDto = Omit<PluginConfig, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

/** One persisted plugin log entry returned by the plugin logs endpoint. */
export interface PluginLogDto {
  id: string;
  pluginId: string;
  companyId: string | null;
  level: PluginLogLevel;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

/** JSON representation of a registered plugin job. */
export type PluginJobDto = Omit<
  PluginJobRecord,
  "nextRunAt" | "createdAt" | "updatedAt"
> & {
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** JSON representation of one plugin job execution. */
export type PluginJobRunDto = Omit<
  PluginJobRunRecord,
  "startedAt" | "finishedAt" | "createdAt"
> & {
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export function serializePluginRecord(record: PluginRecord): PluginRecordDto {
  return {
    ...record,
    installedAt: record.installedAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function serializePluginDetail(
  record: PluginRecord,
  supportsConfigTest: boolean,
): PluginDetailDto {
  return {
    ...serializePluginRecord(record),
    supportsConfigTest,
  };
}

export function serializePluginConfig(config: PluginConfig): PluginConfigDto {
  return {
    ...config,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  };
}

export function serializePluginLog(
  log: Omit<PluginLogDto, "createdAt"> & { createdAt: Date },
): PluginLogDto {
  return {
    ...log,
    createdAt: log.createdAt.toISOString(),
  };
}

export function serializePluginJob(job: PluginJobRecord): PluginJobDto {
  return {
    ...job,
    nextRunAt: job.nextRunAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function serializePluginJobRun(run: PluginJobRunRecord): PluginJobRunDto {
  return {
    ...run,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}
