import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { Agent } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { listAdapterOptions } from "@/adapters/metadata";
import { DraftInput, DraftTextarea } from "@/components/patterns/DraftFields";
import { help } from "./agent-config-help";
import { MarkdownEditor } from "../../markdown/MarkdownEditor";
import { ReportsToPicker } from "./ReportsToPicker";
import {
  RuntimeAgentConfigurationFields,
  type RuntimeAgentConfigurationValues,
} from "./RuntimeAgentConfigurationFields";

type AgentIdentitySectionProps = {
  agent: Agent;
  agents: Agent[];
  capabilities: string;
  instruction: string;
  name: string;
  onCapabilitiesChange: (value: string) => void;
  onInstructionChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onReportsToChange: (value: string | null) => void;
  onTitleChange: (value: string) => void;
  onUploadCapabilitiesImage: (file: File) => Promise<string>;
  reportsTo: string | null;
  title: string;
  uploadPending: boolean;
};

export function AgentIdentitySection({
  agent,
  agents,
  capabilities,
  instruction,
  name,
  onCapabilitiesChange,
  onInstructionChange,
  onNameChange,
  onReportsToChange,
  onTitleChange,
  onUploadCapabilitiesImage,
  reportsTo,
  title,
  uploadPending,
}: AgentIdentitySectionProps) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Identity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <LabeledFormField label="Name" description={help.name}>
          <DraftInput value={name} onCommit={onNameChange} immediate placeholder="Agent name" />
        </LabeledFormField>
        <LabeledFormField label="Title" description={help.title}>
          <DraftInput value={title} onCommit={onTitleChange} immediate placeholder="e.g. VP of Engineering" />
        </LabeledFormField>
        <LabeledFormField label="Reports to" description={help.reportsTo}>
          <ReportsToPicker
            agents={agents}
            value={reportsTo}
            onChange={onReportsToChange}
            excludeAgentIds={[agent.id]}
            chooseLabel="Choose manager…"
          />
        </LabeledFormField>
        <LabeledFormField label="Capabilities" description={help.capabilities}>
          <div aria-busy={uploadPending}>
            <FieldSet disabled={uploadPending} className="min-w-0 gap-0">
              <FieldLegend className="sr-only">Capabilities</FieldLegend>
              <MarkdownEditor
                value={capabilities}
                onChange={onCapabilitiesChange}
                placeholder="Describe what this agent can do..."
                contentClassName="min-h-(--sz-44px) text-sm font-mono"
                readOnly={uploadPending}
                imageUploadHandler={onUploadCapabilitiesImage}
              />
            </FieldSet>
            {uploadPending ? (
              <p role="status" className="mt-1 text-xs text-muted-foreground">
                Uploading image…
              </p>
            ) : null}
          </div>
        </LabeledFormField>
        <LabeledFormField label="Instructions" description={help.instruction}>
          <DraftTextarea
            value={instruction}
            onCommit={onInstructionChange}
            immediate
            minRows={4}
            placeholder="Describe this agent's role, priorities, and durable operating guidance..."
          />
        </LabeledFormField>
      </CardContent>
    </Card>
  );
}

type AgentRuntimeAccessSectionProps = {
  disabled: boolean;
  error: boolean;
  loading: boolean;
  onChange: (value: RuntimeAgentConfigurationValues) => void;
  value: RuntimeAgentConfigurationValues | null;
};

export function AgentRuntimeAccessSection({
  disabled,
  error,
  loading,
  onChange,
  value,
}: AgentRuntimeAccessSectionProps) {
  return (
    <Card className="gap-3 py-4">
      <CardContent className="space-y-3 px-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              Runtime access could not be loaded. Refresh the page and try again.
            </AlertDescription>
          </Alert>
        ) : value ? (
          <RuntimeAgentConfigurationFields value={value} onChange={onChange} disabled={disabled} />
        ) : loading ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading runtime access…
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Runtime access is unavailable for this agent.</p>
        )}
      </CardContent>
    </Card>
  );
}

type AgentAdapterSectionProps = {
  adapterFields: ReactNode;
  adapterType: string;
  hasAdapter: boolean;
  hasAdapterType: boolean;
  isTesting: boolean;
  onAdapterTypeChange: (value: CreateConfigValues["adapterType"]) => void;
  onTest: () => void;
  showAdapterTypeField: boolean;
  testDisabled: boolean;
  testMessage: string | null;
  testMessageIsError: boolean;
};

export function AgentAdapterSection({
  adapterFields,
  adapterType,
  hasAdapter,
  hasAdapterType,
  isTesting,
  onAdapterTypeChange,
  onTest,
  showAdapterTypeField,
  testDisabled,
  testMessage,
  testMessageIsError,
}: AgentAdapterSectionProps) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Adapter</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {showAdapterTypeField ? (
          <LabeledFormField label="Adapter type" description={help.adapterType}>
            <Select value={adapterType} onValueChange={onAdapterTypeChange}>
              <SelectTrigger aria-label="Adapter" size="sm" className="w-full shadow-none">
                <SelectValue placeholder="Select an adapter" />
              </SelectTrigger>
              <SelectContent align="start">
                {listAdapterOptions().map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabeledFormField>
        ) : null}

        {hasAdapterType && hasAdapter ? adapterFields : null}
        {hasAdapterType && !hasAdapter ? (
          <Alert variant="destructive">
            <AlertDescription>This adapter is not available from the local agent catalog.</AlertDescription>
          </Alert>
        ) : null}
        {!hasAdapterType ? (
          <p className="text-xs text-muted-foreground">
            Nothing to show yet. Select an adapter to create this agent's first immutable configuration
            revision.
          </p>
        ) : null}

        {hasAdapterType && hasAdapter ? (
          <Card className="gap-2 p-3 shadow-none">
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Test the exact unsaved model and other runtime settings in a disposable no-prompt session.
                This does not save the agent or verify local execution readiness.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={testDisabled}
                onClick={onTest}
              >
                {isTesting ? "Testing…" : "Test Agent"}
              </Button>
            </div>
            {testMessage ? (
              <Alert
                variant={testMessageIsError ? "destructive" : "default"}
                role={testMessageIsError ? "alert" : "status"}
              >
                <AlertDescription>{testMessage}</AlertDescription>
              </Alert>
            ) : null}
          </Card>
        ) : null}
      </CardContent>
    </Card>
  );
}
