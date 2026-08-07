import type { ServerInfoSnapshot } from "@paperclipai/shared";

export type HealthStatus = {
  status: "ok" | "unhealthy";
  version?: string;
  deploymentExposure?: "private" | "public";
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  features?: {
    companyDeletionEnabled?: boolean;
  };
  serverInfo?: ServerInfoSnapshot;
  devServer?: {
    enabled: true;
    restartRequired: boolean;
    reason: "backend_changes" | null;
    lastChangedAt: string | null;
    changedPathCount: number;
    changedPathsSample: string[];
    autoRestartEnabled: boolean;
    activeRunCount: number;
    waitingForIdle: boolean;
    lastRestartAt: string | null;
  };
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        payload?.error ?? `Failed to load health (${res.status})`,
      );
    }
    return res.json();
  },
};
