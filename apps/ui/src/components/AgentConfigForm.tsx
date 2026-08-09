import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  Agent,
  AgentAdapterConfigurationTestResult,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { adaptersApi } from "../api/adapters";
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
  DraftTextarea,
  help,
} from "./agent-config-primitives";
import { defaultCreateValues } from "./agent-config-defaults";
import { findUIAdapter } from "../adapters";
import { MarkdownEditor } from "./MarkdownEditor";
import { ReportsToPicker } from "./ReportsToPicker";
import { listAdapterOptions, listVisibleAdapterTypes } from "../adapters/metadata";
import { useAdapterCatalogSync } from "../adapters/use-adapter-catalog";
import { buildAgentUpdatePatch, omitUndefinedEntries, type AgentConfigOverlay } from "../lib/agent-config-patch";
import { publicRuntimeMessage } from "../lib/public-runtime-message";
import {
  RuntimeAgentConfigurationFields,
  createEmptyRuntimeAgentConfigurationValues,
  type RuntimeAgentConfigurationValues,
} from "./RuntimeAgentConfigurationFields";

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
  const editProps = mode === "edit" ? props : null;
  const cards = props.sectionLayout === "cards";
  const showAdapterTypeField = props.showAdapterTypeField ?? true;
  const { selectedCompanyId } = useCompany();

  const admittedAdapters = useAdapterCatalogSync();

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

  // Register referentially-stable actions that always delegate to the latest
  // handlers. Registering handleSave/handleCancel directly would re-run the
  // effect below on every render (their identities change per render), and
  // parents that store the action in state would re-render in turn — an
  // infinite "maximum update depth" loop.
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;
  const stableSaveAction = useCallback(() => handleSaveRef.current(), []);
  const stableCancelAction = useCallback(() => handleCancelRef.current(), []);

  useEffect(() => {
    if (!isCreate) {
      props.onDirtyChange?.(isDirty);
      props.onSaveActionChange?.(stableSaveAction);
      props.onCancelActionChange?.(stableCancelAction);
    }
  }, [isCreate, isDirty, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange, stableSaveAction, stableCancelAction]);

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
  const catalogAdapter = useMemo(
    () => admittedAdapters.find((adapter) => adapter.type === adapterType) ?? null,
    [adapterType, admittedAdapters],
  );
  const val = isCreate ? props.values : null;
  const set = isCreate
    ? (patch: Partial<CreateConfigValues>) => props.onChange(patch)
    : null;

  const { data: companyAgents = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none", "list"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(!isCreate && selectedCompanyId),
  });
  const runtimeAccessQuery = useQuery({
    queryKey: editProps
      ? queryKeys.agents.runtimeConfiguration(
          editProps.agent.id,
          editProps.agent.companyId,
        )
      : ["agents", "none", "runtime-configuration"],
    queryFn: () =>
      agentsApi.getRuntimeConfiguration(editProps!.agent.id, editProps!.agent.companyId),
    enabled: !isCreate,
    select: (snapshot): RuntimeAgentConfigurationValues => {
      const defaults = createEmptyRuntimeAgentConfigurationValues();
      return {
        contextGrants: { ...defaults.contextGrants, ...snapshot.contextGrants },
        actionGrants: { ...defaults.actionGrants, ...snapshot.actionGrants },
        mentionReachGrants: {
          ...defaults.mentionReachGrants,
          ...snapshot.mentionReachGrants,
        },
      };
    },
  });
  const runtimeAccess = runtimeAccessQuery.data ?? null;
  const effectiveRuntimeAccess = Object.keys(overlay.runtime).length > 0
    ? overlay.runtime as RuntimeAgentConfigurationValues
    : runtimeAccess;

  const markRuntimeAccess = useCallback((runtime: RuntimeAgentConfigurationValues) => {
    setOverlay((prev) => ({ ...prev, runtime }));
  }, []);

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
  const draftTestConfiguration = useMemo(() => {
    if (!hasAdapterType || !uiAdapter) {
      return { adapterConfig: null, error: null };
    }
    try {
      if (isCreate) {
        return {
          adapterConfig: uiAdapter.buildAdapterConfig(val!),
          error: null,
        };
      }
      const patch = buildAgentUpdatePatch(props.agent, overlay);
      const nextAdapterConfig = patch.adapterConfig;
      return {
        adapterConfig:
          typeof nextAdapterConfig === "object"
          && nextAdapterConfig !== null
          && !Array.isArray(nextAdapterConfig)
            ? nextAdapterConfig as Record<string, unknown>
            : { ...config },
        error: null,
      };
    } catch (error) {
      return {
        adapterConfig: null,
        error:
          error instanceof Error
            ? error.message
            : "Adapter configuration could not be built.",
      };
    }
  }, [config, hasAdapterType, isCreate, overlay, props, uiAdapter, val]);
  const draftTestFingerprint = useMemo(
    () => draftTestConfiguration.adapterConfig === null
      ? null
      : JSON.stringify([
          selectedCompanyId,
          isCreate ? "create" : props.agent.id,
          adapterType,
          draftTestConfiguration.adapterConfig,
        ]),
    [
      adapterType,
      draftTestConfiguration.adapterConfig,
      isCreate,
      props,
      selectedCompanyId,
    ],
  );
  const draftTestContextToken = useMemo(
    () => Object.freeze({ fingerprint: draftTestFingerprint }),
    [catalogAdapter, draftTestFingerprint, uiAdapter],
  );
  const currentDraftTestContextToken = useRef(draftTestContextToken);
  currentDraftTestContextToken.current = draftTestContextToken;
  const [draftTestFeedback, setDraftTestFeedback] = useState<{
    contextToken: object;
    result: AgentAdapterConfigurationTestResult | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    setDraftTestFeedback(null);
  }, [draftTestContextToken]);
  const testDraftConfiguration = useMutation({
    mutationFn: async (input: {
      companyId: string;
      adapterType: string;
      adapterConfig: Record<string, unknown>;
      contextToken: object;
    }) => await adaptersApi.testConfiguration(
      input.companyId,
      input.adapterType,
      { adapterConfig: input.adapterConfig },
    ),
    onSuccess: (result, input) => {
      if (currentDraftTestContextToken.current !== input.contextToken) return;
      setDraftTestFeedback({
        contextToken: input.contextToken,
        result,
        error: null,
      });
    },
    onError: (error, input) => {
      if (currentDraftTestContextToken.current !== input.contextToken) return;
      setDraftTestFeedback({
        contextToken: input.contextToken,
        result: null,
        error:
          error instanceof Error
            ? publicRuntimeMessage(error.message, "Agent configuration test failed.")
            : "Agent configuration test failed.",
      });
    },
  });
  const visibleDraftTestFeedback =
    draftTestFeedback?.contextToken === draftTestContextToken
      ? draftTestFeedback
      : null;
  const visibleDraftTestResult = visibleDraftTestFeedback?.result ?? null;
  const draftTestDisabled =
    !selectedCompanyId
    || !hasAdapterType
    || draftTestConfiguration.adapterConfig === null
    || draftTestFingerprint === null
    || testDraftConfiguration.isPending
    || isSavePending;

  function handleTestAgent() {
    if (
      draftTestDisabled
      || !selectedCompanyId
      || draftTestConfiguration.adapterConfig === null
      || draftTestFingerprint === null
    ) return;
    setDraftTestFeedback(null);
    testDraftConfiguration.mutate({
      companyId: selectedCompanyId,
      adapterType,
      adapterConfig: draftTestConfiguration.adapterConfig,
      contextToken: draftTestContextToken,
    });
  }

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
            <Field label="Instructions" hint={help.instruction}>
              <DraftTextarea
                value={eff("identity", "instruction", props.agent.instruction ?? "") ?? ""}
                onCommit={(v) => mark("identity", "instruction", v.trim() ? v : null)}
                immediate
                minRows={4}
                placeholder="Describe this agent's role, priorities, and durable operating guidance..."
              />
            </Field>
          </div>
        </div>
      )}

      {/* ---- Runtime access (edit only) ---- */}
      {!isCreate && (
        <div className={cn(!cards && "border-b border-border")}>
          <div className={cn(cards ? "border border-border rounded-lg p-4 space-y-3" : "px-4 pb-3 space-y-3")}>
            {runtimeAccessQuery.isError ? (
              <p role="alert" className="text-xs text-destructive">
                Runtime access could not be loaded. Refresh the page and try
                again.
              </p>
            ) : effectiveRuntimeAccess ? (
              <RuntimeAgentConfigurationFields
                value={effectiveRuntimeAccess}
                onChange={markRuntimeAccess}
                disabled={isSavePending}
              />
            ) : runtimeAccessQuery.isLoading ? (
              <p role="status" className="text-xs text-muted-foreground">
                Loading runtime access…
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Runtime access is unavailable for this agent.
              </p>
            )}
          </div>
        </div>
      )}

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
              This adapter is not available from the local agent catalog.
            </p>
          )}

          {!hasAdapterType && (
            <p className="text-xs text-muted-foreground">
                Nothing to show yet. Select an adapter to create this agent's
                first immutable configuration revision.
            </p>
          )}

          {hasAdapterType && uiAdapter ? (
            <div className="space-y-2 rounded-md border border-border bg-muted p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Test the exact unsaved model and other runtime settings in a
                  disposable no-prompt session. This does not save the agent
                  or verify local execution readiness.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={draftTestDisabled}
                  onClick={handleTestAgent}
                >
                  {testDraftConfiguration.isPending
                    ? "Testing…"
                    : "Test Agent"}
                </Button>
              </div>
              {draftTestConfiguration.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {draftTestConfiguration.error}
                </p>
              ) : visibleDraftTestFeedback?.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {visibleDraftTestFeedback.error}
                </p>
              ) : visibleDraftTestResult?.status === "failed" ? (
                <p role="alert" className="text-xs text-destructive">
                  {publicRuntimeMessage(visibleDraftTestResult.message)}
                </p>
              ) : visibleDraftTestResult?.status === "ready" ? (
                <p role="status" className="text-xs text-foreground">
                  The local agent accepted this exact draft configuration.
                </p>
              ) : null}
            </div>
          ) : null}

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
  const adapterList = listAdapterOptions();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value
              ? findUIAdapter(value)?.label ?? value
              : "Select an adapter"}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="max-h-(--radix-popover-content-available-height) w-(--radix-popover-trigger-width) overflow-y-auto p-1"
        align="start"
      >
        {adapterList.map((item) => (
          <button
            key={item.value}
            className={cn(
              "flex items-center justify-between w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
              item.value === value && "bg-accent",
            )}
            onClick={() => {
              onChange(item.value);
              setOpen(false);
            }}
          >
            <span>{item.label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
