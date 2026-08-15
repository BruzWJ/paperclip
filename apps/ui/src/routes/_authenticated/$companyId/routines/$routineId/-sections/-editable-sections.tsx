export * from "./-DeliverySection";
export * from "./-OverviewSection";
export * from "./-TriggersSection";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import type { EnvBinding } from "@paperclipai/shared";
import { Braces, Edit3 } from "lucide-react";
import { useMemo } from "react";
import { EnvironmentVariablesEditor } from "../../../../../../features/environment-variables-editor";
import { RoutineVariablesEditor } from "../-detail/-RoutineVariablesEditor";
import { useRoutineDetail } from "./-context";

export function SecretsSection() {
  const { editDraft, setEditDraft, availableSecrets, createSecret, secretMessage, copySecretValue } =
    useRoutineDetail();
  const recentlyUsedSecrets = useMemo(
    () =>
      [...availableSecrets]
        .filter((secret) => secret.status === "active")
        .sort((a, b) => {
          const refDelta = (b.referenceCount ?? 0) - (a.referenceCount ?? 0);
          return refDelta || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        })
        .slice(0, 8),
    [availableSecrets],
  );
  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription>
          Routine secrets apply to every task this routine creates. They override matching keys in project and
          agent env. <span className="font-mono">PAPERCLIP_*</span> names are reserved.
        </AlertDescription>
      </Alert>
      {secretMessage ? (
        <Alert>
          <AlertTitle>{secretMessage.title}</AlertTitle>
          <AlertDescription>
            <p>Save this now. Paperclip will not show the value again.</p>
            {secretMessage.entries.map((entry, index) => (
              <div key={`${entry.webhookUrl}-${index}`} className="space-y-2">
                {[
                  ["Webhook URL", entry.webhookUrl, `routine-webhook-url-${index}`],
                  ["Webhook secret", entry.webhookSecret, `routine-webhook-secret-${index}`],
                ].map(([label, value, id]) => (
                  <InputGroup key={id}>
                    <InputGroupInput id={id} aria-label={label} value={value} readOnly />
                    <InputGroupButton onClick={() => copySecretValue(label, value)}>Copy</InputGroupButton>
                  </InputGroup>
                ))}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      <EnvironmentVariablesEditor
        value={(editDraft.env ?? {}) as Record<string, EnvBinding>}
        secrets={availableSecrets}
        recentlyUsedSecrets={recentlyUsedSecrets}
        onCreateSecret={(name, value) => createSecret.mutateAsync({ name, value })}
        onChange={(env) => setEditDraft((current) => ({ ...current, env: env ?? null }))}
      />
    </div>
  );
}

export function VariablesSection() {
  const { editDraft, setEditDraft, navigateToSection } = useRoutineDetail();
  return (
    <div className="space-y-4">
      <Alert>
        <AlertDescription>
          <p>
            Variables are detected from <code className="font-mono">{"{{placeholders}}"}</code> in the title
            and instructions.
          </p>
          <Button variant="secondary" size="sm" onClick={() => navigateToSection("overview")}>
            <Edit3 />
            Edit instructions
          </Button>
        </AlertDescription>
      </Alert>
      {editDraft.variables.length > 0 ? (
        <RoutineVariablesEditor
          title={editDraft.title}
          description={editDraft.description}
          value={editDraft.variables}
          onChange={(variables) => setEditDraft((current) => ({ ...current, variables }))}
        />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Braces />
            </EmptyMedia>
            <EmptyTitle>No variables yet</EmptyTitle>
            <EmptyDescription>
              Add a {"{{placeholder}}"} in the title or instructions to create one.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => navigateToSection("overview")}>Edit instructions</Button>
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}
