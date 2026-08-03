/**
 * Resume + destroy lifecycle helpers for Kubernetes sandbox leases.
 *
 * Resume semantics: a lease is resumable only while its Sandbox custom
 * resource still exists and its pod is Running/Ready (or becomes Ready within
 * a short bounded wait). Unlike Daytona — where a stopped sandbox
 * can be started again by ID — Kubernetes pods are NOT restartable: once the
 * pod backing a lease is gone or terminally failed, the lease can never be
 * revived in place. That asymmetry is intentional; the plugin reports the
 * lease as expired so the server can provision a new Sandbox.
 *
 * Destroy semantics: the forced cleanup path. Deletes every resource
 * acquireLease created (the Sandbox CR and its pod), treating 404s as success
 * so it is idempotent and safe to call against half-deleted leases.
 */

import type { KubeClients } from "./kube-client.js";
import {
  deleteSandboxCr,
  findPodForSandbox,
  waitForSandboxReady,
} from "./sandbox-cr-orchestrator.js";

/** True when a Kubernetes API error means "resource not found" (HTTP 404). */
export function isKubeNotFoundError(err: unknown): boolean {
  const code = (err as { code?: number; statusCode?: number }).code
    ?? (err as { code?: number; statusCode?: number }).statusCode;
  return code === 404;
}

async function ignoreNotFound(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (!isKubeNotFoundError(err)) throw err;
  }
}

export type ResumeCheckResult =
  | { resumable: true; podName: string | null; phase: "Pending" | "Running" }
  | { resumable: false; reason: string };

export interface ResumeCheckInput {
  namespace: string;
  /** Sandbox custom-resource name == providerLeaseId. */
  name: string;
  /** Bounded wait for an existing Sandbox pod to report Ready. */
  readyTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Check whether the workload behind a lease is still alive and exec-able.
 * Returns `resumable: false` (never throws "expected" states) when the
 * resource is gone (404), terminally failed, terminating, or doesn't become
 * Ready within the bounded wait — all of which mean the caller should fall
 * back to a fresh acquireLease.
 */
export async function checkLeaseResumable(
  clients: KubeClients,
  input: ResumeCheckInput,
): Promise<ResumeCheckResult> {
  // Bounded wait for the Sandbox to report Ready. waitForSandboxReady fails
  // fast on Failed/Terminating; a timeout means the pod never came up. None
  // of those states are resumable — Kubernetes pods cannot restart in place.
  try {
    await waitForSandboxReady(clients, input.namespace, input.name, {
      timeoutMs: input.readyTimeoutMs ?? 30_000,
      pollMs: input.pollMs ?? 1_000,
    });
  } catch (err) {
    if (isKubeNotFoundError(err)) {
      return { resumable: false, reason: "Sandbox CR no longer exists" };
    }
    return {
      resumable: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let podName: string | null;
  try {
    podName = await findPodForSandbox(clients, input.namespace, input.name);
  } catch (err) {
    // CR deleted between the readiness check and the pod lookup.
    if (isKubeNotFoundError(err)) {
      return { resumable: false, reason: "Sandbox CR no longer exists" };
    }
    throw err;
  }
  if (!podName) {
    return {
      resumable: false,
      reason: "Sandbox is Ready but no backing pod was found",
    };
  }

  // Confirm the pod itself is Running and not being torn down — the CR
  // status can lag pod deletion.
  let pod: { metadata?: { deletionTimestamp?: unknown }; status?: { phase?: string } };
  try {
    pod = await clients.core.readNamespacedPod({
      namespace: input.namespace,
      name: podName,
    }) as typeof pod;
  } catch (err) {
    if (isKubeNotFoundError(err)) {
      return { resumable: false, reason: `Pod ${podName} no longer exists` };
    }
    throw err;
  }
  const podPhase = pod.status?.phase;
  const terminating = Boolean(pod.metadata?.deletionTimestamp);
  if (podPhase !== "Running" || terminating) {
    return {
      resumable: false,
      reason: `Pod ${podName} is ${terminating ? "terminating" : podPhase ?? "in an unknown phase"}`,
    };
  }
  return { resumable: true, podName, phase: "Running" };
}

export interface DestroyLeaseInput {
  namespace: string;
  /** Sandbox custom-resource name == providerLeaseId. */
  name: string;
  podName: string | null;
}

/**
 * Forcibly delete every resource acquireLease created for this lease.
 * Workload first, then the pod explicitly so a wedged controller cannot strand
 * it. Every delete treats 404 as success — destroy is idempotent.
 */
export async function destroyLeaseResources(
  clients: KubeClients,
  input: DestroyLeaseInput,
): Promise<void> {
  await ignoreNotFound(deleteSandboxCr(clients, input.namespace, input.name));
  if (input.podName) {
    await ignoreNotFound(
      clients.core.deleteNamespacedPod({
        namespace: input.namespace,
        name: input.podName,
      }),
    );
  }
}
