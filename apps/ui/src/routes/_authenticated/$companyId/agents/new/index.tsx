import { createFileRoute } from "@tanstack/react-router";
import { assertOnlySearchKeys, optionalExactSearchString } from "@/routes/-search";
import { useState, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { agentsApi } from "@/api/agents";
import { tasksApi } from "@/api/tasks";
import { queryKeys } from "@/lib/queryKeys";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
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
    adapterType: optionalExactSearchString(search.adapterType, "adapterType", 200),
  };
}

export const Route = createFileRoute("/_authenticated/$companyId/agents/new/")({
  validateSearch: validateNewAgentSearch,
  component: NewAgent,
});

function createValuesForAdapterType(adapterType: CreateConfigValues["adapterType"]): CreateConfigValues {
  const { adapterType: _discard, ...defaults } = defaultCreateValues;
  return { ...defaults, adapterType };
}

type NewAgentDraft = Parameters<typeof buildNewAgentControlPlanePayloads>[0];

function NewAgent() {
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
  const [runtimeAccess, setRuntimeAccess] = useState<RuntimeAgentConfigurationValues>(
    createEmptyRuntimeAgentConfigurationValues,
  );
  const [configValues, setConfigValues] = useState<CreateConfigValues>(defaultCreateValues);
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
      return createValuesForAdapterType(requested as CreateConfigValues["adapterType"]);
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
        error: error instanceof Error ? error.message : "Adapter configuration could not be built.",
      };
    }
  }, [configValues]);
  const adapterConfiguration = useStructuralAdapterConfiguration({
    adapterType: configValues.adapterType,
    adapterConfig: adapterConfigResolution.config,
    enabled: adapterConfigResolution.error === null,
  });

  const createAgent = useMutation({
    mutationFn: async (input: { draft: NewAgentDraft; taskTitle: string | null; taskRequest: string }) => {
      const payloads = buildNewAgentControlPlanePayloads(input.draft);
      const created = await agentsApi.createRuntimeAgent(
        companyId,
        payloads.runtimeAgent,
        createIdempotencyKeyRef.current,
      );
      await agentsApi.updateOperationalConfiguration(created.agent.id, payloads.operational);
      await agentsApi.createAdapterConfigRevision(created.agent.id, payloads.adapterRevision);
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
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  function handleSubmit() {
    if (!name.trim() || !initialRequest.trim() || !adapterConfiguration.valid) return;
    setFormError(null);
    createAgent.mutate({
      draft: {
        name,
        title,
        capabilities,
        instruction,
        reportsTo: null,
        runtimeAccess,
        configValues,
        adapterConfig: adapterConfigResolution.config,
      },
      taskTitle: initialTaskTitle.trim() || null,
      taskRequest: initialRequest.trim(),
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">New Agent</h1>
        <p className="text-sm text-muted-foreground mt-1">Advanced agent configuration</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent profile</CardTitle>
          <CardDescription>Set the identity and durable operating guidance for this agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input
                id="agent-name"
                placeholder="Agent name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-title">Title</FieldLabel>
              <FieldDescription>Optional display title shown alongside the agent.</FieldDescription>
              <Input
                id="agent-title"
                placeholder="Title (display only)"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-capabilities">Capabilities</FieldLabel>
              <FieldDescription>
                Verbatim capability description shown only when another agent can choose this agent as a
                target.
              </FieldDescription>
              <Textarea
                id="agent-capabilities"
                className="min-h-24"
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
                placeholder="What work is this agent equipped to handle?"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-instructions">Agent instructions</FieldLabel>
              <FieldDescription>
                Optional high-level role guidance Paperclip delivers during this agent&apos;s session
                bootstrap.
              </FieldDescription>
              <Textarea
                id="agent-instructions"
                className="min-h-24"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="Describe the agent's role, priorities, and durable operating guidance."
              />
            </Field>
          </FieldGroup>
          <Alert className="mt-6">
            <AlertDescription>
              Board-created agents start at the root. Reporting lines can be changed later through
              runtime-agent configuration.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runtime access</CardTitle>
          <CardDescription>Control what this agent may read, change, and mention.</CardDescription>
        </CardHeader>
        <CardContent>
          <RuntimeAgentConfigurationFields
            value={runtimeAccess}
            onChange={setRuntimeAccess}
            disabled={createAgent.isPending}
          />
        </CardContent>
      </Card>

      <AgentConfigForm
        mode="create"
        sectionLayout="cards"
        values={configValues}
        onChange={(patch) => setConfigValues((prev) => ({ ...prev, ...patch }))}
      />

      {!configValues.adapterType ? (
        <Alert role="status">
          <AlertTitle>Choose an adapter</AlertTitle>
          <AlertDescription>Select an adapter to begin its explicit configuration.</AlertDescription>
        </Alert>
      ) : adapterConfigResolution.error ? (
        <Alert variant="destructive">
          <AlertTitle>Invalid adapter configuration</AlertTitle>
          <AlertDescription>{adapterConfigResolution.error}</AlertDescription>
        </Alert>
      ) : adapterConfiguration.isLoading ? (
        <Alert role="status">
          <Spinner aria-hidden="true" />
          <AlertTitle>Loading configuration</AlertTitle>
          <AlertDescription>Loading adapter configuration schema…</AlertDescription>
        </Alert>
      ) : adapterConfiguration.error || !adapterConfiguration.configOptions ? (
        <Alert variant="destructive">
          <AlertTitle>Configuration unavailable</AlertTitle>
          <AlertDescription>
            Adapter configuration schema unavailable.{" "}
            {adapterConfiguration.error ?? "The adapter did not return a schema."}
          </AlertDescription>
        </Alert>
      ) : adapterConfiguration.fieldErrors.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Configuration incomplete</AlertTitle>
          <AlertDescription>
            Adapter configuration is incomplete:{" "}
            {adapterConfiguration.fieldErrors.map((error) => error.message).join(" ")}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert role="status">
          <AlertTitle>Configuration valid</AlertTitle>
          <AlertDescription>
            Draft configuration is structurally valid. Test Agent applies these exact settings through a
            disposable local runtime session; full workspace readiness is checked against the persisted run.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Initial task</CardTitle>
          <CardDescription>
            Creating an agent also creates its first ordinary board task. This immutable request is the only
            source that starts provider work.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="initial-task-title">Title</FieldLabel>
              <FieldDescription>Optional board task title.</FieldDescription>
              <Input
                id="initial-task-title"
                placeholder="Task title (optional)"
                value={initialTaskTitle}
                onChange={(event) => setInitialTaskTitle(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="initial-task-request">Request</FieldLabel>
              <FieldDescription>Describe the first concrete assignment for this agent.</FieldDescription>
              <Textarea
                id="initial-task-request"
                className="min-h-28"
                placeholder="Describe the first concrete assignment"
                value={initialRequest}
                onChange={(event) => setInitialRequest(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {formError ? (
            <Alert variant="destructive" className="mt-6">
              <AlertTitle>Could not create agent</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="justify-between gap-2">
          <Button
            variant="outline"
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
            disabled={
              !name.trim() || !initialRequest.trim() || !adapterConfiguration.valid || createAgent.isPending
            }
            onClick={handleSubmit}
          >
            {createAgent.isPending ? <Spinner aria-hidden="true" /> : null}
            {createAgent.isPending ? "Creating…" : "Create agent"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
