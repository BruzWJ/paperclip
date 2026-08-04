/**
 * One target-local execution-runtime mapping keyed by an ACPX agent name.
 * This is not an agent catalog and cannot govern picker availability: ACPX
 * supplies those names at runtime. A target may use the mapping only to bind
 * an already-selected agent to its image and network configuration.
 *
 * Replace semantics: when a target mapping is supplied it is its complete
 * declared runtime set. There are no built-in defaults.
 */
export interface AdapterRegistryEntry {
  /** The exact ACPX agent identity selected for the run. */
  adapterType: string;
  /** Whether this target can execute the exact ACPX agent identity. */
  enabled?: boolean;
  /** k8s-sandbox-only: container image the Job/Sandbox runs. */
  runtimeImage?: string;
  /** k8s-sandbox-only: egress FQDN allow-list for the agent pod. */
  allowFqdns?: string[];
  /** k8s-sandbox-only: liveness/probe command. */
  probeCommand?: string[];
}
