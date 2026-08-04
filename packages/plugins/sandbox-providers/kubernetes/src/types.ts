import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export const kubernetesProviderConfigSchema = z
  .object({
    inCluster: z.boolean().default(false),
    kubeconfig: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    reuseLease: z.boolean().optional().default(false),
    archiveOnRelease: z.boolean().optional(),

    namespacePrefix: z.string().regex(/^[a-z0-9-]{1,32}$/).default("paperclip-"),
    companySlug: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),

    imageRegistry: z.string().url().optional(),
    imageAllowList: z.array(z.string()).default([]),
    imagePullSecrets: z.array(z.string()).default([]),

    egressAllowFqdns: z.array(z.string()).default([]),
    egressAllowCidrs: z.array(z.string().regex(cidrRegex, "Invalid CIDR")).default([]),
    egressMode: z.enum(["cilium", "standard"]).default("standard"),

    defaultResources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
      })
      .optional(),

    runtimeClassName: z.string().optional(),
    serviceAccountAnnotations: z.record(z.string()).default({}),

    podActivityDeadlineSec: z.number().int().positive().default(3600),

    /**
     * Optional operator-selected fallback for non-agent calls. Normal issue
     * execution always supplies the exact ACPX-discovered agent type for its
     * run, so this field cannot create or advertise an agent catalog.
     */
    adapterType: z
      .string()
      .min(1)
      .refine((value) => value === value.trim(), {
        message: "adapterType must be an exact non-blank identifier",
      })
      .optional(),

    /**
     * Authoritative runtime declaration. Kubernetes has no built-in
     * provider-specific image, egress, or probe defaults.
     */
    adapters: adapterRegistrySchema.min(1),

  })
  .strict()
  .superRefine((config, context) => {
    const seenAdapterTypes = new Set<string>();
    for (const [index, entry] of config.adapters.entries()) {
      if (seenAdapterTypes.has(entry.adapterType)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["adapters", index, "adapterType"],
          message:
            "adapter runtime registry must contain each exact adapterType once",
        });
      }
      seenAdapterTypes.add(entry.adapterType);
    }
    if (config.adapterType !== undefined) {
      const defaultRuntime = config.adapters.find(
        (entry) =>
          entry.adapterType === config.adapterType &&
          entry.enabled !== false,
      );
      if (!defaultRuntime) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["adapters"],
          message:
            "adapters must contain an enabled runtime for adapterType",
        });
      }
    }
  })
  .refine(
    (cfg) => cfg.inCluster || cfg.kubeconfig,
    {
      message:
        "kubernetes provider requires one of `inCluster` or `kubeconfig`",
    },
  );

export type KubernetesProviderConfig = z.infer<typeof kubernetesProviderConfigSchema>;

export function parseKubernetesProviderConfig(input: unknown): KubernetesProviderConfig {
  return kubernetesProviderConfigSchema.parse(input);
}

export const kubernetesLeaseMetadataSchema = z
  .object({
    namespace: z.string().min(1),
    /** Name of the Sandbox custom resource backing this lease. */
    sandboxName: z.string().min(1),
    podName: z.string().min(1).nullable(),
    phase: z.enum(["Pending", "Running", "Failed"]),
    resumedLease: z.literal(true).optional(),
  })
  .strict();

export type KubernetesLeaseMetadata = z.infer<typeof kubernetesLeaseMetadataSchema>;

export function parseKubernetesLeaseMetadata(input: unknown): KubernetesLeaseMetadata {
  const record =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  // The server stores provider metadata beside its own lease envelope. Project
  // only this provider's exact owned fields into the strict parser.
  return kubernetesLeaseMetadataSchema.parse({
    namespace: record.namespace,
    sandboxName: record.sandboxName,
    podName: record.podName,
    phase: record.phase,
    ...(record.resumedLease === undefined
      ? {}
      : { resumedLease: record.resumedLease }),
  });
}
