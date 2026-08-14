import type { Server } from "node:http";
import { logger } from "./middleware/logger.js";
import { printStartupBanner } from "./startup-banner.js";
import { getTelemetryClient } from "./telemetry.js";

export interface PersistedWorkSchedulerOptions {
  enabled: boolean;
  intervalMs: number;
  reconcile(): Promise<void>;
  tickRoutines(): Promise<{ triggered: number; [key: string]: unknown }>;
}

export interface PersistedWorkScheduler {
  start(): Promise<void>;
  stopAndWait(): Promise<void>;
}

export function createPersistedWorkScheduler(options: PersistedWorkSchedulerOptions): PersistedWorkScheduler {
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const inFlight = new Set<Promise<void>>();

  const track = (work: Promise<unknown>) => {
    let tracked: Promise<void>;
    tracked = Promise.resolve(work)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    return tracked;
  };

  const recover = (phase: "startup" | "periodic") =>
    options.reconcile().catch((error) => {
      logger.error({ err: error }, `${phase} persisted task-execution recovery failed`);
    });

  return {
    async start() {
      const startupRecovery = recover("startup");
      track(startupRecovery);
      await startupRecovery;
      if (!options.enabled) return;

      interval = setInterval(() => {
        if (stopped) return;
        track(recover("periodic"));
        track(
          options
            .tickRoutines()
            .then((result) => {
              if (result.triggered > 0) {
                logger.info({ ...result }, "routine scheduler created ordinary tasks");
              }
            })
            .catch((error) => {
              logger.error({ err: error }, "routine scheduler tick failed");
            }),
        );
      }, options.intervalMs);
    },

    async stopAndWait() {
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

export interface ListenForServerOptions {
  host: string;
  listenPort: number;
  openOnListen: boolean;
  banner: Parameters<typeof printStartupBanner>[0];
}

export async function listenForServer(server: Server, options: ListenForServerOptions): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen(options.listenPort, options.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${options.host}:${options.listenPort}`);
      if (options.openOnListen) {
        const openHost = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
        const url = `http://${openHost}:${options.listenPort}`;
        void import("open")
          .then((module) => module.default(url))
          .then(() => logger.info(`Opened browser at ${url}`))
          .catch((error) => {
            logger.warn({ err: error, url }, "Failed to open browser on startup");
          });
      }
      printStartupBanner(options.banner);
      resolveListen();
    });
  });
}

export interface GracefulShutdownOptions {
  stopRestartCoordinator(): void;
  stopScheduler(): Promise<void>;
  drainExecutions(signal: "SIGINT" | "SIGTERM"): Promise<void>;
  shutdownApp(): Promise<void> | undefined;
  closeLiveEvents(): Promise<void>;
  closeDatabases(): Promise<void>;
  shutdownInstrumentation(): Promise<void>;
}

export function registerGracefulShutdown(options: GracefulShutdownOptions): void {
  const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
    options.stopRestartCoordinator();
    await options.stopScheduler();

    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      telemetryClient.stop();
      await telemetryClient.flush();
    }

    try {
      await options.drainExecutions(signal);
      logger.info({ signal }, "graceful task-execution drain complete");
    } catch (error) {
      logger.error({ err: error, signal }, "graceful task-execution drain failed");
    }
    try {
      await options.shutdownApp();
    } catch (error) {
      logger.error({ err: error }, "Failed to shut down application services cleanly");
    }
    try {
      await options.closeLiveEvents();
    } catch (error) {
      logger.error({ err: error }, "Failed to close live Socket.IO transport cleanly");
    }
    try {
      await options.closeDatabases();
    } catch (error) {
      logger.error({ err: error }, "Failed to close PostgreSQL client cleanly");
    }
    await options.shutdownInstrumentation();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
