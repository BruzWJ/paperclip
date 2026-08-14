import * as t from "./plugin-before-prompt-dispatcher.test-support.js";
const { describe, it, harness, installation, expect, promptInput } = t;
const { PLUGIN_BEFORE_PROMPT_TIMEOUT_MS, worker, vi } = t;
const { createPostgresPluginBeforePromptSourceReader, sourceDb } = t;
const { canonicalSourceRow } = t;

describe("plugin before-prompt dispatcher", () => {
  it("skips source inspection when no plugin is eligible", async () => {
    const subject = harness({
      initial: [
        installation({
          id: "ordinary",
          order: 2,
          capabilities: [],
        }),
      ],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).resolves.toBe("Canonical request");
    await expect(subject.dispatcher.dispatch(promptInput())).resolves.toBe("Canonical request");

    expect(subject.source.resolve).not.toHaveBeenCalled();
    expect(subject.call).not.toHaveBeenCalled();
  });

  it("runs observers in install order with the exact scoped source", async () => {
    const second = installation({ id: "second", order: 2 });
    const first = installation({ id: "first", order: 1 });
    const subject = harness({
      initial: [second, first],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).resolves.toBe("Canonical request");

    expect(subject.call.mock.calls.map((call) => call[0])).toEqual(["first", "second"]);
    expect(subject.call.mock.calls[0]?.[1]).toBe("beforePrompt");
    expect(subject.call.mock.calls[0]?.[3]).toBe(PLUGIN_BEFORE_PROMPT_TIMEOUT_MS);
    expect(subject.call.mock.calls[0]?.[4]).toEqual({
      companyId: "company-1",
      canonicalSession: {
        taskId: "task-1",
        sessionId: "session-1",
        snapshotHighWaterSeq: 7,
      },
    });
    expect(subject.call.mock.calls[0]?.[2]).toMatchObject({
      projectId: "project-1",
      sourceMessageId: "msg_source_0000000000000000001",
      sourceMessageSeq: 7,
      snapshotHighWaterSeq: 7,
    });
    expect(subject.managerCall).not.toHaveBeenCalled();
    expect(subject.installations.listReady).toHaveBeenLastCalledWith();
  });

  it("fails closed before source inspection when an approved hook is unavailable", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const subject = harness({
      initial: [approved],
      workers: {
        approved: worker(approved, { supportedMethods: [] }),
      },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toMatchObject({
      code: "plugin_before_prompt_dispatch_failed",
    });
    expect(subject.source.resolve).not.toHaveBeenCalled();
    expect(subject.call).not.toHaveBeenCalled();
  });

  it("rejects a source boundary that the canonical source reader does not confirm", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const subject = harness({
      initial: [approved],
      source: {
        resolve: vi.fn(async () => ({
          projectId: null,
          sourceMessageSeq: 6,
        })),
      },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow("different Session boundary");
    expect(subject.call).not.toHaveBeenCalled();
  });

  it("rejects any result outside the exact prompt contribution shape", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const invalid = harness({
      initial: [approved],
      results: {
        approved: {
          content: "memory",
        } as unknown as t.PluginBeforePromptResult,
      },
    });
    await expect(invalid.dispatcher.dispatch(promptInput())).rejects.toThrow("invalid result");
  });

  it("fails closed on worker failure", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const failed = harness({ initial: [approved] });
    failed.call.mockRejectedValueOnce(new Error("worker crash"));
    await expect(failed.dispatcher.dispatch(promptInput())).rejects.toMatchObject({
      code: "plugin_before_prompt_dispatch_failed",
      cause: expect.objectContaining({ message: "worker crash" }),
    });
  });

  it("rejects a worker whose manifest identity does not match its installation", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const hook = vi.fn(async () => null);
    const subject = harness({
      initial: [approved],
      workers: {
        approved: worker(approved, {
          manifestIdentity: "mismatched-manifest",
          call: hook as t.PluginWorkerHandle["call"],
        }),
      },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow(
      "worker is unavailable or lacks beforePrompt",
    );
    expect(subject.source.resolve).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("never invokes a same-manifest replacement installed during source inspection", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const originalCall = vi.fn(async () => null);
    const replacementCall = vi.fn(async () => null);
    const original = worker(approved, {
      call: originalCall as t.PluginWorkerHandle["call"],
    });
    const replacement = worker(approved, {
      call: replacementCall as t.PluginWorkerHandle["call"],
    });
    const subject = harness({
      initial: [approved],
      workers: { approved: original },
    });
    vi.mocked(subject.source.resolve).mockImplementationOnce(async () => {
      subject.setWorker(approved.id, replacement);
      return { projectId: "project-1", sourceMessageSeq: 7 };
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow("authority changed");
    expect(originalCall).not.toHaveBeenCalled();
    expect(replacementCall).not.toHaveBeenCalled();
    expect(subject.managerCall).not.toHaveBeenCalled();
  });

  it("never invokes a same-manifest replacement installed while its hook runs", async () => {
    const approved = installation({ id: "approved", order: 1 });
    const replacementCall = vi.fn(async () => null);
    const replacement = worker(approved, {
      call: replacementCall as t.PluginWorkerHandle["call"],
    });
    let subject: t.PluginBeforePromptHarness;
    const originalCall = vi.fn(async () => {
      subject.setWorker(approved.id, replacement);
      return null;
    });
    const original = worker(approved, {
      call: originalCall as t.PluginWorkerHandle["call"],
    });
    subject = harness({
      initial: [approved],
      workers: { approved: original },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow("authority changed");
    expect(originalCall).toHaveBeenCalledOnce();
    expect(replacementCall).not.toHaveBeenCalled();
    expect(subject.managerCall).not.toHaveBeenCalled();
  });

  it("rejects when an installation leaves the ready set during the hook", async () => {
    const before = installation({ id: "approved", order: 1 });
    const subject = harness({
      initial: [before],
      final: [],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow("authority changed");
  });

  it("revalidates acknowledged hooks and rejects config races", async () => {
    const before = installation({ id: "approved", order: 1 });
    const configChanged = harness({
      initial: [before],
      final: [
        {
          ...before,
          configId: "config-1",
          configUpdatedAt: new Date("2026-08-05T00:00:01.000Z"),
        },
      ],
    });
    await expect(configChanged.dispatcher.dispatch(promptInput())).rejects.toThrow("authority changed");
  });

  it("rejects config content drift even when persistence timestamps collide", async () => {
    const before = {
      ...installation({ id: "approved", order: 1 }),
      configId: "config-1",
      configUpdatedAt: new Date("2026-08-05T00:00:01.000Z"),
      configJson: { endpoint: "https://before.example" },
    };
    const subject = harness({
      initial: [before],
      final: [
        {
          ...before,
          configJson: { endpoint: "https://after.example" },
        },
      ],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow("authority changed");
  });

  it("rejects a newly eligible hook crossing the barrier", async () => {
    const first = installation({ id: "first", order: 1 });
    const subject = harness({
      initial: [first],
      final: [first, installation({ id: "second", order: 2 })],
    });

    await expect(subject.dispatcher.dispatch(promptInput())).rejects.toThrow("authority changed");
  });

  it("composes non-empty contributions in immutable install order", async () => {
    const second = installation({ id: "second", order: 2 });
    const first = installation({ id: "first", order: 1 });
    const subject = harness({
      initial: [second, first],
      results: {
        first: { prependText: "First prelude" },
        second: { prependText: "Second prelude" },
      },
    });

    await expect(subject.dispatcher.dispatch(promptInput())).resolves.toBe(
      "First prelude\n\nSecond prelude\n\nCanonical request",
    );
    expect(subject.installations.listReady).toHaveBeenCalledTimes(2);
  });
});

describe("Postgres before-prompt canonical source reader", () => {
  it("accepts one exact readable user source and derives project scope", async () => {
    const reader = createPostgresPluginBeforePromptSourceReader(sourceDb([canonicalSourceRow({})]));

    await expect(reader.resolve(promptInput())).resolves.toEqual({
      projectId: "project-from-db",
      sourceMessageSeq: 7,
    });
  });

  it("rejects text drift, non-source message kinds, and unprojected Sessions", async () => {
    const drift = createPostgresPluginBeforePromptSourceReader(
      sourceDb([canonicalSourceRow({ text: "different" })]),
    );
    await expect(drift.resolve(promptInput())).rejects.toThrow("source text does not match");

    const assistant = createPostgresPluginBeforePromptSourceReader(
      sourceDb([canonicalSourceRow({ type: "assistant" })]),
    );
    await expect(assistant.resolve(promptInput())).rejects.toThrow("source text does not match");

    const unprojected = createPostgresPluginBeforePromptSourceReader(
      sourceDb([canonicalSourceRow({ projectedEventSeq: 6 })]),
    );
    await expect(unprojected.resolve(promptInput())).rejects.toThrow(
      "outside the readable Session projection",
    );
  });

  it("rejects missing or ambiguous canonical source rows", async () => {
    const missing = createPostgresPluginBeforePromptSourceReader(sourceDb([]));
    await expect(missing.resolve(promptInput())).rejects.toThrow("not one exact canonical Session message");

    const row = canonicalSourceRow({});
    const ambiguous = createPostgresPluginBeforePromptSourceReader(sourceDb([row, row]));
    await expect(ambiguous.resolve(promptInput())).rejects.toThrow("not one exact canonical Session message");
  });
});
