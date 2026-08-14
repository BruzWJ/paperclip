import * as t from "./server-startup.test-support.js";
const { describe, registerSuiteSetup, it, loadConfigMock, buildTestConfig, vi } = t;
const { startServer, expect, routineServiceMock, createDbMock } = t;
const { liveEventsSocketCloseMock, taskExecutionDispatcherShutdownMock } = t;
const { taskExecutionCancellationDrainMock, appShutdownMock } = t;
const { createBetterAuthInstanceMock, createAppMock, fakeServer } = t;

describe("startServer scheduler wiring", () => {
  registerSuiteSetup();

  it("keeps routine ticks active in the task-execution scheduler", async () => {
    loadConfigMock.mockReturnValue(
      buildTestConfig({
        taskExecutionSchedulerEnabled: true,
        taskExecutionSchedulerIntervalMs: 30000,
      }),
    );
    const intervalCallbacks: Array<{
      callback: () => void;
      delay: number;
    }> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      intervalCallbacks.push({
        callback,
        delay: delay ?? 0,
      });
      return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    try {
      await startServer();

      const schedulerInterval = intervalCallbacks.find(({ delay }) => delay === 30_000);
      expect(schedulerInterval).toBeDefined();
      schedulerInterval?.callback();
      await Promise.resolve();
      await Promise.resolve();

      expect(routineServiceMock.tickScheduledTriggers).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

describe("startServer database client lifecycle", () => {
  registerSuiteSetup({
    databaseMigrationUrl: "postgres://paperclip:paperclip@migration.example.test:5432/paperclip",
  });

  it("closes each mocked client exactly once during graceful shutdown", async () => {
    const primaryClientEnd = vi.fn(async () => undefined);
    const migrationClientEnd = vi.fn(async () => undefined);
    createDbMock
      .mockReturnValueOnce({ $client: { end: primaryClientEnd } } as never)
      .mockReturnValueOnce({ $client: { end: migrationClientEnd } } as never);

    const sigintListenersBefore = new Set(process.listeners("SIGINT"));
    const sigtermListenersBefore = new Set(process.listeners("SIGTERM"));
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined as never) as typeof process.exit);

    let sigintListener: NodeJS.SignalsListener | undefined;
    let sigtermListener: NodeJS.SignalsListener | undefined;
    try {
      await startServer();

      sigintListener = process.listeners("SIGINT").find((listener) => !sigintListenersBefore.has(listener));
      sigtermListener = process
        .listeners("SIGTERM")
        .find((listener) => !sigtermListenersBefore.has(listener));
      expect(sigintListener).toBeDefined();
      expect(sigtermListener).toBeDefined();

      sigtermListener?.("SIGTERM");
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(0);
      });

      expect(createDbMock).toHaveBeenCalledTimes(2);
      expect(liveEventsSocketCloseMock).toHaveBeenCalledExactlyOnceWith();
      expect(primaryClientEnd).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
      expect(migrationClientEnd).toHaveBeenCalledExactlyOnceWith({
        timeout: 5,
      });

      const dispatcherOrder = taskExecutionDispatcherShutdownMock.mock.invocationCallOrder[0]!;
      const cancellationOrder = taskExecutionCancellationDrainMock.mock.invocationCallOrder[0]!;
      const appOrder = appShutdownMock.mock.invocationCallOrder[0]!;
      const socketOrder = liveEventsSocketCloseMock.mock.invocationCallOrder[0]!;
      const primaryDbOrder = primaryClientEnd.mock.invocationCallOrder[0]!;
      const migrationDbOrder = migrationClientEnd.mock.invocationCallOrder[0]!;
      expect(dispatcherOrder).toBeLessThan(appOrder);
      expect(cancellationOrder).toBeLessThan(appOrder);
      expect(appOrder).toBeLessThan(socketOrder);
      expect(socketOrder).toBeLessThan(primaryDbOrder);
      expect(socketOrder).toBeLessThan(migrationDbOrder);
    } finally {
      if (sigintListener) process.removeListener("SIGINT", sigintListener);
      if (sigtermListener) process.removeListener("SIGTERM", sigtermListener);
      exitSpy.mockRestore();
    }
  });
});

describe("startServer auth origin setup", () => {
  registerSuiteSetup();

  it("initializes auth without a parallel trusted-origin catalog", async () => {
    loadConfigMock.mockReturnValue(
      buildTestConfig({
        deploymentExposure: "public",
        port: 3210,
        allowedHostnames: ["board.example.test"],
        authPublicBaseUrl: "https://paperclip.example.test",
      }),
    );
    await startServer();

    expect(createBetterAuthInstanceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        port: 3210,
        authPublicBaseUrl: "https://paperclip.example.test",
      }),
    );
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      serverPort: 3210,
    });
  });
});

describe("startServer runtime API URL handling", () => {
  registerSuiteSetup({
    configureAuth: false,
    restoreRuntimeEnvironment: true,
  });

  it("derives a host-based runtime API URL", async () => {
    const started = await startServer();

    expect(started.apiUrl).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3210");
  });

  it("keeps loopback as the runtime API URL when allowed hostnames are present", async () => {
    loadConfigMock.mockReturnValueOnce(
      buildTestConfig({
        allowedHostnames: ["192.168.1.50"],
      }),
    );

    const started = await startServer();

    expect(started.apiUrl).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3210");
  });

  it("uses the exact configured port with a canonical public URL", async () => {
    loadConfigMock.mockReturnValueOnce(
      buildTestConfig({
        deploymentExposure: "public",
        port: 3100,
        authPublicBaseUrl: "http://my-host.ts.net:3100",
      }),
    );
    const started = await startServer();

    expect(started.listenPort).toBe(3100);
    expect(fakeServer.listen).toHaveBeenCalledWith(3100, "127.0.0.1", expect.any(Function));
    expect(started.apiUrl).toBe("http://my-host.ts.net:3100");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://my-host.ts.net:3100");
  });

  it("keeps no-port auth public URLs stable on the exact configured port", async () => {
    loadConfigMock.mockReturnValueOnce(
      buildTestConfig({
        deploymentExposure: "public",
        port: 3100,
        authPublicBaseUrl: "https://paperclip.example",
      }),
    );
    const started = await startServer();

    expect(started.listenPort).toBe(3100);
    expect(started.apiUrl).toBe("https://paperclip.example");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("https://paperclip.example");
  });
});
