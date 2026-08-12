import { createFileRoute } from "@tanstack/react-router";
import {
  assertOnlySearchKeys,
  optionalExactSearchString,
} from "@/routes/-search";
import { useState, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { agentsApi } from "@/api/agents";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AgentConfigForm } from "@/components/AgentConfigForm";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import { getUIAdapter } from "@/adapters";
import { useAdapterCatalogSyncState } from "@/adapters/use-adapter-catalog";
import { isValidAdapterType } from "@/adapters/metadata";
import { buildNewAgentControlPlanePayloads } from "@/lib/new-agent-control-plane-payload";
import { useStructuralAdapterConfiguration } from "@/adapters/use-structural-adapter-configuration";
import {
  RuntimeAgentConfigurationFields,
  createEmptyRuntimeAgentConfigurationValues,
  type RuntimeAgentConfigurationValues,
} from "@/components/RuntimeAgentConfigurationFields";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";

export function validateNewAgentSearch(search: Record<string, unknown>): {
  adapterType?: string;
} {
  assertOnlySearchKeys(search, ["adapterType"]);
  return {
    adapterType: optionalExactSearchString(
      search.adapterType,
      "adapterType",
      200,
    ),
  };
}

export const Route = createFileRoute("/_authenticated/$companyId/agents/new/")({
  validateSearch: validateNewAgentSearch,
  component: NewAgent,
});

function createValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"],
): CreateConfigValues {
  const { adapterType: _discard, ...defaults } = defaultCreateValues;
  return { ...defaults, adapterType };
}

export function NewAgent() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const companyId = useCompanyRouteId();
  const { adapterType: presetAdapterType } = getRouteApi(
    "/_authenticated/$companyId/agents/new/",
  ).useSearch();

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [instruction, setInstruction] = useState("");
  const [initialTaskTitle, setInitialTaskTitle] = useState("");
  const [initialRequest, setInitialRequest] = useState("");
  const [runtimeAccess, setRuntimeAccess] =
    useState<RuntimeAgentConfigurationValues>(
      createEmptyRuntimeAgentConfigurationValues,
    );
  const [configValues, setConfigValues] =
    useState<CreateConfigValues>(defaultCreateValues);
  const [formError, setFormError] = useState<string | null>(null);
  const createIdempotencyKeyRef = useRef(crypto.randomUUID());
  const { adapters: admittedAdapters } = useAdapterCatalogSyncState();

  useEffect(() => {
    setBreadcrumbs([
      {
        label: "Agents",
        renderLink: (content) => (
          <Link to="/$companyId/agents" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "New Agent" },
    ]);
  }, [companyId, setBreadcrumbs]);

  useEffect(() => {
    const requested = presetAdapterType;
    if (!requested) return;
    if (!isValidAdapterType(requested)) return;
    setConfigValues((prev) => {
      if (prev.adapterType === requested) return prev;
      return createValuesForAdapterType(
        requested as CreateConfigValues["adapterType"],
      );
    });
  }, [admittedAdapters, presetAdapterType]);

  const adapterConfigResolution = useMemo(() => {
    try {
      const adapter = getUIAdapter(configValues.adapterType);
      return {
        config: adapter.buildAdapterConfig(configValues),
        error: null,
      };
    } catch (error) {
      return {
        config: {},
        error:
          error instanceof Error
            ? error.message
            : "Adapter configuration could not be built.",
      };
    }
  }, [configValues]);
  const adapterConfiguration = useStructuralAdapterConfiguration({
    adapterType: configValues.adapterType,
    adapterConfig: adapterConfigResolution.config,
    enabled: adapterConfigResolution.error === null,
  });

  const createAgent = useMutation({
    mutationFn: async (input: {
      payloads: ReturnType<typeof buildNewAgentControlPlanePayloads>;
      taskTitle: string | null;
      taskRequest: string;
    }) => {
      const created = await agentsApi.createRuntimeAgent(
        companyId,
        input.payloads.runtimeAgent,
        createIdempotencyKeyRef.current,
      );
      await agentsApi.updateOperationalConfiguration(
        created.agent.id,
        input.payloads.operational,
      );
      await agentsApi.createAdapterConfigRevision(
        created.agent.id,
        input.payloads.adapterRevision,
      );
      const task = await tasksApi.create(companyId, {
        request: input.taskRequest,
        ownerAgentId: created.agent.id,
        idempotencyKey: `new-agent:${created.agent.id}:initial-task`,
        ...(input.taskTitle ? { title: input.taskTitle } : {}),
      });
      return { agent: created.agent, task };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(companyId),
      });
      void navigate({
        to: "/$companyId/tasks/$taskNumber",
        params: {
          companyId,
          taskNumber: String(result.task.taskNumber),
        },
      });
    },
    onError: (error) => {
      setFormError(
        error instanceof Error ? error.message : "Failed to create agent",
      );
    },
  });

  function handleSubmit() {
    if (!name.trim() || !initialRequest.trim() || !adapterConfiguration.valid)
      return;
    setFormError(null);
    createAgent.mutate({
      payloads: buildNewAgentControlPlanePayloads({
        name,
        title,
        capabilities,
        instruction,
        reportsTo: null,
        runtimeAccess,
        configValues,
        adapterConfig: adapterConfigResolution.config,
      }),
      taskTitle: initialTaskTitle.trim() || null,
      taskRequest: initialRequest.trim(),
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">New Agent</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Advanced agent configuration
        </p>
      </div>

      <div className="border border-border">
        {/* Name */}
        <div className="px-4 pt-4 pb-2">
          <input
            aria-label="Agent name"
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Agent name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        {/* Title */}
        <div className="px-4 pb-2">
          <input
            aria-label="Agent title"
            className="w-full bg-transparent outline-none text-sm text-muted-foreground placeholder:text-muted-foreground/40 focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Title (display only)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="border-t border-border px-4 py-4">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Capabilities</span>
            <span className="text-xs text-muted-foreground">
              Verbatim capability description shown only when another agent can
              choose this agent as a target.
            </span>
            <textarea
              className="min-h-24 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={capabilities}
              onChange={(event) => setCapabilities(event.target.value)}
              placeholder="What work is this agent equipped to handle?"
            />
          </label>
          <p className="mt-2 text-xs text-muted-foreground">
            Board-created agents start at the root. Reporting lines can be
            changed later through runtime-agent configuration.
          </p>
        </div>

        <div className="border-t border-border px-4 py-4">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Agent instructions</span>
            <span className="text-xs text-muted-foreground">
              Optional high-level role guidance Paperclip delivers during this
              agent&apos;s session bootstrap.
            </span>
            <textarea
              className="min-h-24 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Describe the agent's role, priorities, and durable operating guidance."
            />
          </label>
        </div>

        <div className="border-t border-border px-4 py-4">
          <RuntimeAgentConfigurationFields
            value={runtimeAccess}
            onChange={setRuntimeAccess}
            disabled={createAgent.isPending}
          />
        </div>

        {/* Shared config form */}
        <AgentConfigForm
          mode="create"
          values={configValues}
          onChange={(patch) =>
            setConfigValues((prev) => ({ ...prev, ...patch }))
          }
        />

        <div className="border-t border-border px-4 py-4">
          <div className="space-y-3">
            {!configValues.adapterType ? (
              <p className="text-xs text-muted-foreground">
                Select an adapter to begin its explicit configuration.
              </p>
            ) : adapterConfigResolution.error ? (
              <p role="alert" className="text-xs text-destructive">
                {adapterConfigResolution.error}
              </p>
            ) : adapterConfiguration.isLoading ? (
              <p className="text-xs text-muted-foreground">
                Loading adapter configuration schema…
              </p>
            ) : adapterConfiguration.error ||
              !adapterConfiguration.configOptions ? (
              <p role="alert" className="text-xs text-destructive">
                Adapter configuration schema unavailable.{" "}
                {adapterConfiguration.error ??
                  "The adapter did not return a schema."}
              </p>
            ) : adapterConfiguration.fieldErrors.length > 0 ? (
              <p role="alert" className="text-xs text-destructive">
                Adapter configuration is incomplete:{" "}
                {adapterConfiguration.fieldErrors
                  .map((error) => error.message)
                  .join(" ")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Draft configuration is structurally valid. Test Agent applies
                these exact settings through a disposable local runtime session;
                full workspace readiness is checked against the persisted run.
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-border px-4 py-4">
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">Initial task</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Creating an agent also creates its first ordinary board task.
                This immutable request is the only source that starts provider
                work.
              </p>
            </div>
            <input
              aria-label="Initial task title"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Task title (optional)"
              value={initialTaskTitle}
              onChange={(event) => setInitialTaskTitle(event.target.value)}
            />
            <textarea
              aria-label="Initial task request"
              className="min-h-28 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Describe the first concrete assignment"
              value={initialRequest}
              onChange={(event) => setInitialRequest(event.target.value)}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-4 py-3">
          {formError && (
            <p className="text-xs text-destructive mb-2">{formError}</p>
          )}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: "/$companyId/agents",
                    params: { companyId },
                  })
                }
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={
                  !name.trim() ||
                  !initialRequest.trim() ||
                  !adapterConfiguration.valid ||
                  createAgent.isPending
                }
                onClick={handleSubmit}
              >
                {createAgent.isPending ? "Creating…" : "Create agent"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
