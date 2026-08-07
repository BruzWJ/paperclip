import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { resolveSkillSummaryText } from "../lib/company-skill-summary";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { issueUrl } from "../lib/utils";
import { AgentConfigForm } from "../components/AgentConfigForm";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { useAdapterCatalogSync } from "../adapters/use-adapter-catalog";
import { isValidAdapterType } from "../adapters/metadata";
import { buildNewAgentControlPlanePayloads } from "../lib/new-agent-control-plane-payload";
import { useStructuralAdapterConfiguration } from "../adapters/use-structural-adapter-configuration";
import {
  RuntimeAgentConfigurationFields,
  createEmptyRuntimeAgentConfigurationValues,
  type RuntimeAgentConfigurationValues,
} from "../components/RuntimeAgentConfigurationFields";

function createValuesForAdapterType(
  adapterType: CreateConfigValues["adapterType"],
): CreateConfigValues {
  const { adapterType: _discard, ...defaults } = defaultCreateValues;
  return { ...defaults, adapterType };
}

export function NewAgent() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetAdapterType = searchParams.get("adapterType");

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [initialIssueTitle, setInitialIssueTitle] = useState("");
  const [initialRequest, setInitialRequest] = useState("");
  const [runtimeAccess, setRuntimeAccess] =
    useState<RuntimeAgentConfigurationValues>(
      createEmptyRuntimeAgentConfigurationValues,
    );
  const [configValues, setConfigValues] = useState<CreateConfigValues>(defaultCreateValues);
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  // The packaged local runtime accepts the operator-native skill channel;
  // Paperclip must not offer the legacy isolated-home mode that execution
  // rejects before it reaches the local runtime.
  const skillChannel = "operator_native" as const;
  const [formError, setFormError] = useState<string | null>(null);
  const createIdempotencyKeyRef = useRef(crypto.randomUUID());
  const admittedAdapters = useAdapterCatalogSync();

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: "New Agent" },
    ]);
  }, [setBreadcrumbs]);

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
      issueTitle: string | null;
      issueRequest: string;
    }) => {
      const created = await agentsApi.createRuntimeAgent(
        selectedCompanyId!,
        input.payloads.runtimeAgent,
        createIdempotencyKeyRef.current,
      );
      await agentsApi.updateOperationalConfiguration(
        created.agent.id,
        input.payloads.operational,
        selectedCompanyId!,
      );
      await agentsApi.createAdapterConfigRevision(
        created.agent.id,
        input.payloads.adapterRevision,
        selectedCompanyId!,
      );
      const issue = await issuesApi.create(selectedCompanyId!, {
        request: input.issueRequest,
        ownerAgentId: created.agent.id,
        idempotencyKey: `new-agent:${created.agent.id}:initial-issue`,
        ...(input.issueTitle ? { title: input.issueTitle } : {}),
      });
      return { agent: created.agent, issue };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      navigate(issueUrl(result.issue));
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "Failed to create agent");
    },
  });

  function handleSubmit() {
    if (
      !selectedCompanyId
      || !name.trim()
      || !initialRequest.trim()
      || !adapterConfiguration.valid
    ) return;
    setFormError(null);
    const skillByKey = new Map(
      (companySkills ?? []).map((skill) => [skill.key, skill]),
    );
    const companySkillPins: Array<{ key: string; versionId: string }> = [];
    for (const key of selectedSkillKeys) {
      const versionId = skillByKey.get(key)?.currentVersionId;
      if (!versionId) {
        setFormError(`Company skill ${key} has no immutable version to pin.`);
        return;
      }
      companySkillPins.push({ key, versionId });
    }
    createAgent.mutate({
      payloads: buildNewAgentControlPlanePayloads({
        name,
        title,
        capabilities,
        reportsTo: null,
        runtimeAccess,
        configValues,
        adapterConfig: adapterConfigResolution.config,
        companySkillPins,
        skillChannel,
      }),
      issueTitle: initialIssueTitle.trim() || null,
      issueRequest: initialRequest.trim(),
    });
  }

  const availableSkills = (companySkills ?? []).filter((skill) => !skill.key.startsWith("paperclipai/paperclip/"));

  function toggleSkill(key: string, checked: boolean) {
    setSelectedSkillKeys((prev) => {
      if (checked) {
        return prev.includes(key) ? prev : [...prev, key];
      }
      return prev.filter((value) => value !== key);
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
          onChange={(patch) => setConfigValues((prev) => ({ ...prev, ...patch }))}
          applyAdapterSchemaDefaults={false}
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
            ) : adapterConfiguration.error || !adapterConfiguration.schema ? (
              <p role="alert" className="text-xs text-destructive">
                Adapter configuration schema unavailable.{" "}
                {adapterConfiguration.error ?? "The adapter did not return a schema."}
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
                these exact settings through a disposable local runtime session; full
                workspace readiness is checked against the persisted run.
              </p>
            )}

          </div>
        </div>

        <div className="border-t border-border px-4 py-4">
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">Company skills</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Optional provider-owned skills from the company library.
                Paperclip does not add a hidden runtime skill bundle.
              </p>
            </div>
            <div className="grid gap-1.5 text-sm">
              <span className="font-medium">Skill channel</span>
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
                Operator-managed native skills
              </div>
              <span className="text-xs text-muted-foreground">
                The local CLI uses its native skill handling. Paperclip
                performs no isolated skill-home materialization.
              </span>
            </div>
            {availableSkills.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No optional company skills installed yet.
              </p>
            ) : (
              <div className="space-y-3">
                {availableSkills.map((skill) => {
                  const inputId = `skill-${skill.id}`;
                  const checked = selectedSkillKeys.includes(skill.key);
                  const summaryText = resolveSkillSummaryText(skill, { fallbackKey: true });
                  return (
                    <div key={skill.id} className="flex items-start gap-3">
                      <Checkbox
                        id={inputId}
                        checked={checked}
                        onCheckedChange={(next) => toggleSkill(skill.key, next === true)}
                      />
                      <label htmlFor={inputId} className="grid gap-1 leading-none">
                        <span className="text-sm font-medium">{skill.name}</span>
                        {summaryText ? <span className="text-xs text-muted-foreground">{summaryText}</span> : null}
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-border px-4 py-4">
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">Initial issue</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Creating an agent also creates its first ordinary board issue.
                This immutable request is the only source that starts provider work.
              </p>
            </div>
            <input
              aria-label="Initial issue title"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Issue title (optional)"
              value={initialIssueTitle}
              onChange={(event) => setInitialIssueTitle(event.target.value)}
            />
            <textarea
              aria-label="Initial issue request"
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
              <Button variant="outline" size="sm" onClick={() => navigate("/agents")}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={
                  !name.trim()
                  || !initialRequest.trim()
                  || !adapterConfiguration.valid
                  || createAgent.isPending
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
