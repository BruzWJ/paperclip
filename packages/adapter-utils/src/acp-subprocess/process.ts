import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { sanitizeInheritedProviderChildEnv } from "../server-utils.js";
import type { AcpSubprocessLaunch } from "./contract.js";

const MAX_CAPTURED_STDERR_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export interface AcpSubprocessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface AcpSubprocessStartOptions {
  readonly onStderr?: (chunk: string) => void;
  /** Fires after the transport wrapper has produced its first ACP byte. */
  readonly onFirstStdoutChunk?: () => void;
  readonly redactStderr: (chunk: string) => string;
}

/**
 * Host-side process mechanics prepared by the selected execution target.
 *
 * This is deliberately separate from {@link AcpSubprocessLaunch}: the latter
 * remains the immutable, approved ACP launch plus the session cwd. Optional
 * local confinement may wrap that command without changing its identity.
 */
export interface AcpSubprocessHostLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

function assertByteMode(
  stream: Readable,
): asserts stream is Readable & { readonly readableObjectMode: false } {
  if (stream.readableObjectMode) {
    throw new TypeError("ACP stdio must use byte-mode Node streams");
  }
}

function isStandardByteReadableStream(
  value: unknown,
): value is ReadableStream<Uint8Array> {
  return value instanceof ReadableStream;
}

export interface AcpSubprocess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stream: Stream;
  readonly stderr: () => string;
  readonly exited: Promise<AcpSubprocessExit>;
  cancel(signal?: NodeJS.Signals): void;
  closeAndReap(graceMs?: number): Promise<AcpSubprocessExit>;
  terminateAndReap(graceMs?: number): Promise<AcpSubprocessExit>;
  closeInput(): void;
}

function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the status check and group kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Cancellation is idempotent; an already-gone process needs no action.
  }
}

/**
 * Starts one fresh ACP frontend subprocess for one Paperclip prompt-bearing
 * unit. Node streams are converted with the standard WHATWG bridges before
 * being handed to the official SDK's NDJSON transport.
 */
export function spawnPreparedAcpSubprocess(
  launch: AcpSubprocessLaunch,
  hostLaunch: AcpSubprocessHostLaunch,
  options: AcpSubprocessStartOptions,
): AcpSubprocess {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...sanitizeInheritedProviderChildEnv(process.env),
    ...hostLaunch.environment,
  };
  for (const [key, value] of Object.entries(childEnvironment)) {
    if (value === undefined) delete childEnvironment[key];
  }
  const child = spawn(hostLaunch.command, [...hostLaunch.args], {
    cwd: hostLaunch.cwd,
    env: childEnvironment,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  assertByteMode(child.stdout);
  if (options.onFirstStdoutChunk) {
    child.stdout.once("data", () => {
      options.onFirstStdoutChunk?.();
    });
  }
  const output: WritableStream<Uint8Array> = Writable.toWeb(child.stdin);
  const input = Readable.toWeb(child.stdout);
  if (!isStandardByteReadableStream(input)) {
    throw new TypeError("ACP stdout did not produce a standard byte stream");
  }
  const stream = ndJsonStream(output, input);

  let capturedStderr = Buffer.alloc(0);
  child.stderr.on("data", (value: Buffer | string) => {
    const source = Buffer.isBuffer(value)
      ? value.toString("utf8")
      : value;
    let redacted: string;
    try {
      redacted = options.redactStderr(source);
    } catch {
      redacted = "[ACP stderr redaction failed]";
    }
    const chunk = Buffer.from(redacted, "utf8");
    if (capturedStderr.byteLength < MAX_CAPTURED_STDERR_BYTES) {
      const remaining = MAX_CAPTURED_STDERR_BYTES - capturedStderr.byteLength;
      capturedStderr = Buffer.concat([
        capturedStderr,
        chunk.subarray(0, remaining),
      ]);
    }
    options.onStderr?.(redacted);
  });

  const exited = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  async function waitForExit(graceMs: number): Promise<AcpSubprocessExit | null> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), graceMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function requireGraceMs(graceMs: number): void {
    if (!Number.isInteger(graceMs) || graceMs < 0) {
      throw new TypeError("ACP termination grace must be a nonnegative integer");
    }
  }

  return {
    child,
    stream,
    stderr: () => capturedStderr.toString("utf8"),
    exited,
    cancel(signal = "SIGTERM") {
      terminateProcessGroup(child, signal);
    },
    async closeAndReap(graceMs = DEFAULT_TERMINATION_GRACE_MS) {
      requireGraceMs(graceMs);
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
      const cleanExit = await waitForExit(graceMs);
      if (cleanExit) return cleanExit;
      terminateProcessGroup(child, "SIGTERM");
      const terminated = await waitForExit(graceMs);
      if (terminated) return terminated;
      terminateProcessGroup(child, "SIGKILL");
      return exited;
    },
    async terminateAndReap(graceMs = DEFAULT_TERMINATION_GRACE_MS) {
      requireGraceMs(graceMs);
      terminateProcessGroup(child, "SIGTERM");
      const terminated = await waitForExit(graceMs);
      if (terminated) return terminated;
      terminateProcessGroup(child, "SIGKILL");
      return exited;
    },
    closeInput() {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
    },
  };
}
