import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  Agent,
  Environment,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { assetsApi } from "../api/assets";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ChevronDown, X } from "lucide-react";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import {
  Field,
  DraftInput,
  help,
} from "./agent-config-primitives";
import { defaultCreateValues } from "./agent-config-defaults";
import { findUIAdapter } from "../adapters";
import { MarkdownEditor } from "./MarkdownEditor";
import { ReportsToPicker } from "./ReportsToPicker";
import { listAdapterOptions, listVisibleAdapterTypes } from "../adapters/metadata";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { useAdapterCatalogSync } from "../adapters/use-adapter-catalog";
import { buildAgentUpdatePatch, omitUndefinedEntries, type AgentConfigOverlay } from "../lib/agent-config-patch";
import { resolveForcedKubernetesEnvironment } from "../lib/forced-kubernetes-environment";

/* ---- Create mode values ---- */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

/* ---- Props ---- */

type AgentConfigFormProps = {
  onDirtyChange?: (dirty: boolean) => void;
  onSaveActionChange?: (save: (() => void) | null) => void;
  onCancelActionChange?: (cancel: (() => void) | null) => void;
  hideInlineSave?: boolean;
  showAdapterTypeField?: boolean;
  applyAdapterSchemaDefaults?: boolean;
  requireExplicitExecutionEnvironment?: boolean;
  /** "cards" renders each section as heading + bordered card (for settings pages). Default: "inline" (border-b dividers). */
  sectionLayout?: "inline" | "cards";
} & (
  | {
      mode: "create";
      values: CreateConfigValues;
      onChange: (patch: Partial<CreateConfigValues>) => void;
    }
  | {
      mode: "edit";
      agent: Agent;
      onSave: (patch: Record<string, unknown>) => void | Promise<unknown>;
      isSaving?: boolean;
    }
);

/* ---- Edit mode overlay (dirty tracking) ---- */

const emptyOverlay: AgentConfigOverlay = {
  identity: {},
  adapterConfig: {},
  runtime: {},
};

function isOverlayDirty(o: AgentConfigOverlay): boolean {
  return (
    Object.keys(o.identity).length > 0 ||
    o.adapterType !== undefined ||
    Object.keys(o.adapterConfig).length > 0 ||
    Object.keys(o.runtime).length > 0 ||
    o.modelProfiles?.cheap !== undefined
  );
}

/* ---- Shared input class ---- */
const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

/* ---- Form ---- */

export function AgentConfigForm(props: AgentConfigFormProps) {
  const { mode } = props;
  const isCreate = mode === "create";
  const cards = props.sectionLayout === "cards";
  const showAdapterTypeField = props.showAdapterTypeField ?? true;
  const { selectedCompanyId } = useCompany();

  useAdapterCatalogSync();

  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;

  // Instance execution policy (general settings). When `executionMode` is
  // "kubernetes" the instance FORCES all execution onto the managed Kubernetes
  // sandbox; "any"/absent leaves the full environment/adapter choice intact.
  // Reuses the same general-settings query the rest of the UI uses.
  const { data: generalSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    retry: false,
  });
  const { data: instanceSettings } = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    retry: false,
  });

  const { data: environments = [] } = useQuery<Environment[]>({
    queryKey: selectedCompanyId ? queryKeys.environments.list(selectedCompanyId) : ["environments", "none"],
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    // Load environments when the picker is enabled OR when execution is forced
    // onto Kubernetes (so we can resolve and default to the managed K8s env even
    // when the experimental environments picker is otherwise hidden).
    enabled:
      Boolean(selectedCompanyId) &&
      (environmentsEnabled || generalSettings?.executionMode === "kubernetes"),
  });

  // Setting-driven: resolve whether the instance forces Kubernetes execution and
  // which loaded environment is the managed Kubernetes sandbox.
  const { forced: forcedKubernetes, kubernetesEnvironment } = useMemo(
    () => resolveForcedKubernetesEnvironment(generalSettings?.executionMode, environments),
    [generalSettings?.executionMode, environments],
  );
  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to upload images");
      return assetsApi.uploadImage(selectedCompanyId, file, namespace);
    },
  });

  // ---- Edit mode: overlay for dirty tracking ----
  const [overlay, setOverlay] = useState<AgentConfigOverlay>(emptyOverlay);
  const agentRef = useRef<Agent | null>(null);

  // Clear overlay when agent data refreshes (after save)
  useEffect(() => {
    if (!isCreate) {
      if (agentRef.current !== null && props.agent !== agentRef.current) {
        setOverlay({ ...emptyOverlay });
      }
      agentRef.current = props.agent;
    }
  }, [isCreate, !isCreate ? props.agent : undefined]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = !isCreate && isOverlayDirty(overlay);

  type RecordOverlayGroup = "identity" | "adapterConfig" | "runtime";

  /** Read effective value: overlay if dirty, else original */
  function eff<T>(group: RecordOverlayGroup, field: string, original: T): T {
    const o = overlay[group];
    if (field in o) return o[field] as T;
    return original;
  }

  /** Mark field dirty in overlay */
  function mark(group: RecordOverlayGroup, field: string, value: unknown) {
    setOverlay((prev) => ({
      ...prev,
      [group]: { ...prev[group], [field]: value },
    }));
  }

  /** Build accumulated patch and send to parent */
  const handleCancel = useCallback(() => {
    setOverlay({ ...emptyOverlay });
  }, []);

  const handleSave = useCallback(async () => {
    if (isCreate) return;
    if (!isOverlayDirty(overlay)) return;
    await props.onSave(buildAgentUpdatePatch(props.agent, overlay));
  }, [isCreate, isDirty, overlay, props]);

  useEffect(() => {
    if (!isCreate) {
      props.onDirtyChange?.(isDirty);
      props.onSaveActionChange?.(handleSave);
      props.onCancelActionChange?.(handleCancel);
    }
  }, [isCreate, isDirty, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange, handleSave, handleCancel]);

  useEffect(() => {
    if (isCreate) return;
    return () => {
      props.onSaveActionChange?.(null);
      props.onCancelActionChange?.(null);
      props.onDirtyChange?.(false);
    };
  }, [isCreate, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange]);

  // ---- Resolve values ----
  const config = !isCreate ? ((props.agent.adapterConfig ?? {}) as Record<string, unknown>) : {};

  const adapterType = isCreate
    ? props.values.adapterType
    : overlay.adapterType ?? props.agent.adapterType ?? "";
  const hasAdapterType = adapterType.trim().length > 0;

  const uiAdapter = useMemo(() => findUIAdapter(adapterType), [adapterType]);
  const requiresExplicitExecutionEnvironment =
    isCreate && (props.requireExplicitExecutionEnvironment ?? true);
  const supportedEnvironmentDrivers = useMemo(
    () => new Set(uiAdapter?.drivers ?? []),
    [uiAdapter],
  );
  const val = isCreate ? props.values : null;
  const set = isCreate
    ? (patch: Partial<CreateConfigValues>) => props.onChange(patch)
    : null;
  const rawCurrentDefaultEnvironmentId = isCreate
    ? val!.defaultEnvironmentId ?? ""
    : eff("identity", "defaultEnvironmentId", props.agent.defaultEnvironmentId ?? "");
  const currentDefaultEnvironmentId = useMemo(() => {
    if (!rawCurrentDefaultEnvironmentId) return "";
    const selected = environments.find((environment) => environment.id === rawCurrentDefaultEnvironmentId) ?? null;
    if (!selected) return "";
    if (
      selected.driver === "local"
      && !requiresExplicitExecutionEnvironment
    ) return "";
    if (!supportedEnvironmentDrivers.has(selected.driver)) return "";
    if (selected.driver === "sandbox") {
      const provider = typeof selected.config?.provider === "string" ? selected.config.provider : null;
      if (!provider || provider === "fake") return "";
    }
    return rawCurrentDefaultEnvironmentId;
  }, [
    environments,
    rawCurrentDefaultEnvironmentId,
    requiresExplicitExecutionEnvironment,
    supportedEnvironmentDrivers,
  ]);
  const instanceDefaultEnvironmentId = useMemo(() => {
    const environmentId = instanceSettings?.defaultEnvironmentId ?? null;
    if (!environmentId) return "";
    const selected = environments.find((environment) => environment.id === environmentId) ?? null;
    return selected?.driver === "local" ? "" : environmentId;
  }, [environments, instanceSettings?.defaultEnvironmentId]);
  const instanceDefaultEnvironment = useMemo(
    () => environments.find((environment) => environment.id === instanceDefaultEnvironmentId) ?? null,
    [environments, instanceDefaultEnvironmentId],
  );

  // When the instance forces Kubernetes execution, new agents must default to the
  // managed Kubernetes sandbox environment (never the implicit local default).
  // Only applies in create mode and only once the K8s environment is loaded; if
  // none is available the UI surfaces a notice instead of silently selecting it.
  useEffect(() => {
    if (!isCreate || !set || !forcedKubernetes || !kubernetesEnvironment) return;
    if (currentDefaultEnvironmentId === kubernetesEnvironment.id) return;
    set({ defaultEnvironmentId: kubernetesEnvironment.id });
  }, [isCreate, set, forcedKubernetes, kubernetesEnvironment, currentDefaultEnvironmentId]);

  const runnableEnvironments = useMemo(
    () => environments.filter((environment) => {
      if (environment.status !== "active") return false;
      if (!supportedEnvironmentDrivers.has(environment.driver)) return false;
      if (
        environment.driver === "local"
        && !requiresExplicitExecutionEnvironment
      ) return false;
      if (environment.driver !== "sandbox") return true;
      const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
      return provider !== null && provider !== "fake";
    }),
    [
      environments,
      requiresExplicitExecutionEnvironment,
      supportedEnvironmentDrivers,
    ],
  );
  const environmentOptions = runnableEnvironments;
  // `runnableEnvironments` excludes the always-available Local environment, so a
  // single entry already means the user has more than one environment configured
  // (Local + that environment) and the override selector is meaningful.
  const showEnvironmentOverrideControl =
    requiresExplicitExecutionEnvironment
    || environmentsEnabled && (
      forcedKubernetes
      || currentDefaultEnvironmentId.length > 0
      || runnableEnvironments.length >= 1
    );
  const inheritedEnvironmentLabel = instanceDefaultEnvironment
    ? `${instanceDefaultEnvironment.name} (${instanceDefaultEnvironment.driver})`
    : "Local";

  const { data: companyAgents = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none", "list"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(!isCreate && selectedCompanyId),
  });

  /** Props passed to adapter-specific config field components */
  const adapterFieldProps = {
    mode,
    isCreate,
    adapterType,
    values: isCreate ? props.values : null,
    set: isCreate ? (patch: Partial<CreateConfigValues>) => props.onChange(patch) : null,
    config,
    eff: eff as <T>(group: "adapterConfig", field: string, original: T) => T,
    mark: mark as (group: "adapterConfig", field: string, value: unknown) => void,
    applySchemaDefaults: props.applyAdapterSchemaDefaults ?? true,
  };

  const isSavePending = !isCreate && Boolean(props.isSaving);
  return (
    <div className={cn("relative", cards && "space-y-6")}>
      {/* ---- Floating Save button (edit mode, when dirty) ---- */}
      {isDirty && !props.hideInlineSave && (
        <div className="sticky top-0 z-10 flex items-center justify-end px-4 py-2 bg-background/90 backdrop-blur-sm border-b border-primary/20">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isCreate && props.isSaving}
            >
              {!isCreate && props.isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* ---- Identity (edit only) ---- */}
      {!isCreate && (
        <div className={cn(!cards && "border-b border-border")}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Identity</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Identity</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field label="Name" hint={help.name}>
              <DraftInput
                value={eff("identity", "name", props.agent.name)}
                onCommit={(v) => mark("identity", "name", v)}
                immediate
                className={inputClass}
                placeholder="Agent name"
              />
            </Field>
            <Field label="Title" hint={help.title}>
              <DraftInput
                value={eff("identity", "title", props.agent.title ?? "")}
                onCommit={(v) => mark("identity", "title", v || null)}
                immediate
                className={inputClass}
                placeholder="e.g. VP of Engineering"
              />
            </Field>
            <Field label="Reports to" hint={help.reportsTo}>
              <ReportsToPicker
                agents={companyAgents}
                value={eff("identity", "reportsTo", props.agent.reportsTo ?? null)}
                onChange={(id) => mark("identity", "reportsTo", id)}
                excludeAgentIds={[props.agent.id]}
                chooseLabel="Choose manager…"
              />
            </Field>
            <Field label="Capabilities" hint={help.capabilities}>
              <div aria-busy={uploadMarkdownImage.isPending}>
                <fieldset disabled={uploadMarkdownImage.isPending} className="min-w-0 border-0 p-0">
                  <legend className="sr-only">Capabilities</legend>
                  <MarkdownEditor
                    value={eff("identity", "capabilities", props.agent.capabilities ?? "") ?? ""}
                    onChange={(v) => mark("identity", "capabilities", v || null)}
                    placeholder="Describe what this agent can do..."
                    contentClassName="min-h-(--sz-44px) text-sm font-mono"
                    readOnly={uploadMarkdownImage.isPending}
                    imageUploadHandler={async (file) => {
                      const asset = await uploadMarkdownImage.mutateAsync({
                        file,
                        namespace: `agents/${props.agent.id}/capabilities`,
                      });
                      return asset.contentPath;
                    }}
                  />
                </fieldset>
                {uploadMarkdownImage.isPending ? (
                  <p role="status" className="mt-1 text-xs text-muted-foreground">
                    Uploading image…
                  </p>
                ) : null}
              </div>
            </Field>
          </div>
        </div>
      )}

      {/* ---- Execution ---- */}
      {forcedKubernetes ? (
        // Instance execution policy forces the managed Kubernetes sandbox
        // (executionMode=kubernetes): never offer local / non-Kubernetes targets.
        // Render the environment read-only instead of the selectable picker.
        <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Environment</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Environment</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field
              label="Default environment"
              hint="This instance runs all agents in the Kubernetes sandbox. Local execution is disabled."
            >
              {kubernetesEnvironment ? (
                <div className={cn(inputClass, "flex items-center text-muted-foreground")}>
                  {kubernetesEnvironment.name} · Kubernetes sandbox
                </div>
              ) : (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  This instance requires the Kubernetes sandbox, but no managed Kubernetes
                  environment is available for this company yet. Configure one before creating
                  agents; execution will not fall back to local.
                </div>
              )}
            </Field>
          </div>
        </div>
      ) : showEnvironmentOverrideControl ? (
        <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
          {cards
            ? <h3 className="text-sm font-medium mb-3">Environment</h3>
            : <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Environment</div>
          }
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            <Field
              label={
                requiresExplicitExecutionEnvironment
                  ? "Execution environment"
                  : "Environment override"
              }
              hint={
                requiresExplicitExecutionEnvironment
                  ? "Required. The adapter revision is bound to this exact execution target."
                  : undefined
              }
            >
              <div className="space-y-2">
                <select
                  className={inputClass}
                  aria-label={
                    requiresExplicitExecutionEnvironment
                      ? "Execution environment"
                      : "Environment override"
                  }
                  value={currentDefaultEnvironmentId}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (isCreate) {
                      set!({ defaultEnvironmentId: nextValue });
                      return;
                    }
                    mark("identity", "defaultEnvironmentId", nextValue || null);
                  }}
                >
                  <option value="">
                    {requiresExplicitExecutionEnvironment
                      ? "Select an execution environment"
                      : `Default: ${inheritedEnvironmentLabel}`}
                  </option>
                  {environmentOptions.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name} · {environment.driver}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </div>
        </div>
      ) : null}

      {/* ---- Adapter ---- */}
      <div className={cn(!cards && (isCreate ? "border-t border-border" : "border-b border-border"))}>
        <div className={cn(cards ? "flex items-center justify-between mb-3" : "px-4 py-2 flex items-center justify-between gap-2")}>
          {cards
            ? <h3 className="text-sm font-medium">Adapter</h3>
            : <span className="text-xs font-medium text-muted-foreground">Adapter</span>
          }
        </div>
        <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
          {showAdapterTypeField && (
            <Field label="Adapter type" hint={help.adapterType}>
              <AdapterTypeDropdown
                value={adapterType}
                onChange={(t) => {
                  if (isCreate) {
                    // Reset all adapter-specific fields to defaults when switching adapter type
                    const { adapterType: _at, ...defaults } = defaultCreateValues;
                    const nextValues: CreateConfigValues = { ...defaults, adapterType: t };
                    set!(nextValues);
                  } else {
                    setOverlay((prev) => ({
                      ...prev,
                      adapterType: t,
                      modelProfiles: { cheap: { cleared: true } },
                      adapterConfig: {},
                    }));
                  }
                }}
              />
            </Field>
          )}

          {hasAdapterType && uiAdapter && (
            <uiAdapter.ConfigFields {...adapterFieldProps} />
          )}

          {hasAdapterType && !uiAdapter && (
            <p className="text-xs text-destructive">
              This adapter is not in the server-admitted ACP catalog.
            </p>
          )}

          {!hasAdapterType && (
            <p className="text-xs text-muted-foreground">
                Nothing to show yet. Select an adapter to create this agent's
                first immutable configuration revision.
            </p>
          )}

        </div>

      </div>

    </div>
  );
}

/* ---- Internal sub-components ---- */

export function AdapterTypeDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (type: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedDisplay = value ? getAdapterDisplay(value) : null;
  const adapterList = listAdapterOptions();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate", !value && "text-muted-foreground")}>
              {value
                ? findUIAdapter(value)?.label ?? value
                : "Select an adapter"}
            </span>
            {selectedDisplay?.experimental && <ExperimentalBadge />}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-1" align="start">
        {adapterList.map((item) => (
          <button
            key={item.value}
            disabled={item.comingSoon}
            className={cn(
              "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded",
              item.comingSoon
                ? "opacity-40 cursor-not-allowed"
                : "hover:bg-accent/50",
              item.value === value && !item.comingSoon && "bg-accent",
            )}
            onClick={() => {
              if (!item.comingSoon) {
                onChange(item.value);
                setOpen(false);
              }
            }}
          >
            <span className="inline-flex items-center gap-1.5">
              <span>{item.label}</span>
              {item.experimental && <ExperimentalBadge />}
            </span>
            {item.comingSoon && (
              <span className="text-(length:--text-nano) text-muted-foreground">Coming soon</span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ExperimentalBadge() {
  return (
    <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-(length:--text-nano) font-medium leading-none text-amber-700 dark:text-amber-200">
      Experimental
    </span>
  );
}
