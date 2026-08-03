/**
 * One declarative agent-harness ("adapter") entry. The same shape is used for
 * local self-hosting and our operator/cloud: it governs both availability (the
 * picker) and, when the run is sandboxed on Kubernetes, the runtime wiring.
 *
 * Replace semantics: when a registry is supplied it is the COMPLETE declared
 * set. Adopt (built-in defaults) = no registry at all. Remove = omit the entry.
 * Add = include a new entry. Override = redefine an existing adapterType.
 */
export interface AdapterRegistryEntry {
  /** The exact registered ACP adapter identity, e.g. "codex". */
  adapterType: string;
  /** Availability (both local + k8s). Default true. */
  enabled?: boolean;
  /** k8s-sandbox-only: container image the Job/Sandbox runs. */
  runtimeImage?: string;
  /** k8s-sandbox-only: egress FQDN allow-list for the agent pod. */
  allowFqdns?: string[];
  /** k8s-sandbox-only: liveness/probe command. */
  probeCommand?: string[];
}
