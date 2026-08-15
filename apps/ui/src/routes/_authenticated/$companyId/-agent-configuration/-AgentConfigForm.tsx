// Empty collections render dedicated UI when data.length === 0.
import { useOptionalCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent, ItemDescription } from "@/components/ui/item";
import type { Agent, AgentAdapterConfigRevision } from "@paperclipai/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findUIAdapter } from "@/adapters";
import { useAdapterCatalogSyncState } from "@/adapters/use-adapter-catalog";
import { agentsApi } from "@/api/agents";
import { assetsApi } from "@/api/assets";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "@/lib/agent-config-patch";
import { queryKeys } from "@/lib/queryKeys";
import { defaultCreateValues } from "./-agent-config-defaults";
import {
  createEmptyRuntimeAgentConfigurationValues,
  type RuntimeAgentConfigurationValues,
} from "./-RuntimeAgentConfigurationFields";

/* ---- Create mode values ---- */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import {
  AgentAdapterSection,
  AgentIdentitySection,
  AgentRuntimeAccessSection,
} from "./-AgentConfigFormSections";
import { useAgentConfigDraftTest } from "./-useAgentConfigDraftTest";

export const emptyOverlay: AgentConfigOverlay = {
  identity: {},
  adapterConfig: {},
  runtime: {},
};

export function isOverlayDirty(overlay: AgentConfigOverlay): boolean {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  return (
    Object.keys(overlay.identity).length > 0 ||
    overlay.adapterType !== undefined ||
    Object.keys(overlay.adapterConfig).length > 0 ||
    Object.keys(overlay.runtime).length > 0
  );
}

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

/* ---- Form ---- */

export function AgentConfigForm(props: AgentConfigFormProps) {
  const { mode } = props;
  const isCreate = mode === "create";
  const editProps = mode === "edit" ? props : null;
  const showAdapterTypeField = props.showAdapterTypeField ?? true;
  const companyId = useOptionalCompanyRouteId();

  const { adapters: admittedAdapters } = useAdapterCatalogSyncState();

  const uploadMarkdownImage = useMutation({
    mutationFn: async ({ file, namespace }: { file: File; namespace: string }) => {
      if (!companyId) throw new Error("Select a company to upload images");
      return assetsApi.uploadImage(companyId, file, namespace);
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
    await props.onSave(buildAgentUpdatePatch(config, overlay));
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
  }, [
    isCreate,
    isDirty,
    props.onDirtyChange,
    props.onSaveActionChange,
    props.onCancelActionChange,
    stableSaveAction,
    stableCancelAction,
  ]);

  useEffect(() => {
    if (isCreate) return;
    return () => {
      props.onSaveActionChange?.(null);
      props.onCancelActionChange?.(null);
      props.onDirtyChange?.(false);
    };
  }, [isCreate, props.onDirtyChange, props.onSaveActionChange, props.onCancelActionChange]);

  const currentRevisionQuery = useQuery({
    queryKey: editProps
      ? queryKeys.agents.currentAdapterConfigRevisionRoot(editProps.agent.id)
      : ["agents", "none", "adapter-config-revision-current"],
    queryFn: () => agentsApi.getCurrentAdapterConfigRevision(editProps!.agent.id),
    enabled: editProps !== null && editProps.agent.currentAdapterConfigRevisionId !== null,
  });
  const currentRevision = !isCreate
    ? (currentRevisionQuery.data as AgentAdapterConfigRevision | null | undefined)
    : null;
  const config = currentRevision
    ? Object.fromEntries(
        currentRevision.acpConfiguration.sessionConfigSelections.map((selection) => [
          selection.configId,
          selection.value,
        ]),
      )
    : {};

  const adapterType = isCreate
    ? props.values.adapterType
    : (overlay.adapterType ?? currentRevision?.acpConfiguration.launchProfile.registryName ?? "");
  const hasAdapterType = adapterType.length > 0 && adapterType === adapterType.trim();

  const uiAdapter = findUIAdapter(adapterType);
  const catalogAdapter = useMemo(
    () => admittedAdapters.find((adapter) => adapter.type === adapterType) ?? null,
    [adapterType, admittedAdapters],
  );
  const val = isCreate ? props.values : null;
  const set = isCreate ? (patch: Partial<CreateConfigValues>) => props.onChange(patch) : null;

  const { data: companyAgents = [] } = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "none", "list"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(!isCreate && companyId),
  });
  const runtimeAccessQuery = useQuery({
    queryKey: editProps
      ? queryKeys.agents.runtimeConfiguration(editProps.agent.id, editProps.agent.companyId)
      : ["agents", "none", "runtime-configuration"],
    queryFn: () => agentsApi.getRuntimeConfiguration(editProps!.agent.id),
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
  const effectiveRuntimeAccess =
    Object.keys(overlay.runtime).length > 0
      ? (overlay.runtime as RuntimeAgentConfigurationValues)
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
  const pending = isSavePending;
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
      const patch = buildAgentUpdatePatch(config, overlay);
      const nextAdapterConfig = patch.adapterConfig;
      return {
        adapterConfig:
          typeof nextAdapterConfig === "object" &&
          nextAdapterConfig !== null &&
          !Array.isArray(nextAdapterConfig)
            ? (nextAdapterConfig as Record<string, string | boolean>)
            : { ...config },
        error: null,
      };
    } catch (error) {
      return {
        adapterConfig: null,
        error: error instanceof Error ? error.message : "Adapter configuration could not be built.",
      };
    }
  }, [config, hasAdapterType, isCreate, overlay, props, uiAdapter, val]);
  const draftTest = useAgentConfigDraftTest({
    adapterConfig: draftTestConfiguration.adapterConfig,
    adapterType,
    catalogConfigOptions: catalogAdapter?.configOptions ?? null,
    companyId,
    contextId: isCreate ? "create" : props.agent.id,
    draftError: draftTestConfiguration.error,
    hasAdapter: Boolean(catalogAdapter && uiAdapter),
    isSavePending,
  });
  return (
    <div className="relative space-y-6">
      {isDirty && !props.hideInlineSave ? (
        <Item variant="outline" size="sm" className="sticky top-0 z-10 justify-end bg-background">
          <ItemContent className="flex-none">
            <ItemDescription>Unsaved changes</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button size="sm" onClick={handleSave} disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </ItemActions>
        </Item>
      ) : null}

      {!isCreate ? (
        <AgentIdentitySection
          agent={props.agent}
          agents={companyAgents}
          capabilities={eff("identity", "capabilities", props.agent.capabilities ?? "") ?? ""}
          instruction={eff("identity", "instruction", props.agent.instruction ?? "") ?? ""}
          name={eff("identity", "name", props.agent.name)}
          onCapabilitiesChange={(value) => mark("identity", "capabilities", value || null)}
          onInstructionChange={(value) => mark("identity", "instruction", value.trim() ? value : null)}
          onNameChange={(value) => mark("identity", "name", value)}
          onReportsToChange={(value) => mark("identity", "reportsTo", value)}
          onTitleChange={(value) => mark("identity", "title", value || null)}
          onUploadCapabilitiesImage={async (file) => {
            const asset = await uploadMarkdownImage.mutateAsync({
              file,
              namespace: "agents/" + props.agent.id + "/capabilities",
            });
            return asset.contentPath;
          }}
          reportsTo={eff("identity", "reportsTo", props.agent.reportsTo ?? null)}
          title={eff("identity", "title", props.agent.title ?? "")}
          uploadPending={uploadMarkdownImage.isPending}
        />
      ) : null}

      {!isCreate ? (
        <AgentRuntimeAccessSection
          disabled={pending}
          error={runtimeAccessQuery.isError}
          loading={runtimeAccessQuery.isLoading}
          onChange={markRuntimeAccess}
          value={effectiveRuntimeAccess}
        />
      ) : null}

      <AgentAdapterSection
        adapterFields={hasAdapterType && uiAdapter ? <uiAdapter.ConfigFields {...adapterFieldProps} /> : null}
        adapterType={adapterType}
        hasAdapter={Boolean(uiAdapter)}
        hasAdapterType={hasAdapterType}
        isTesting={draftTest.isTesting}
        onAdapterTypeChange={(nextAdapterType) => {
          if (isCreate) {
            const { adapterType: _adapterType, ...defaults } = defaultCreateValues;
            const nextValues: CreateConfigValues = {
              ...defaults,
              adapterType: nextAdapterType,
            };
            set!(nextValues);
          } else {
            setOverlay((previous) => ({
              ...previous,
              adapterType: nextAdapterType,
              adapterConfig: {},
            }));
          }
        }}
        onTest={draftTest.test}
        showAdapterTypeField={showAdapterTypeField}
        testDisabled={draftTest.disabled}
        testMessage={draftTest.message}
        testMessageIsError={draftTest.messageIsError}
      />
    </div>
  );
}
