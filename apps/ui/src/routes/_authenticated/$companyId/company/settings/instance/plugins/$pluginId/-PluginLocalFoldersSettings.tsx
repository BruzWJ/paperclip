// Empty collections render dedicated UI when data.length === 0.
import { pluginsApi, type PluginLocalFolderStatus } from "@/api/plugins";
import { ChoosePathButton } from "@/components/patterns/PathInstructionsModal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemHeader,
  ItemTitle,
} from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { queryKeys } from "@/lib/queryKeys";
import type { PluginLocalFolderDeclaration } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { PluginOperationResult } from "@/plugins/plugin-launcher-types";

interface PluginLocalFoldersSettingsProps {
  pluginId: string;
  companyId: string;
  declarations: PluginLocalFolderDeclaration[];
}

export function PluginLocalFoldersSettings({
  pluginId,
  companyId,
  declarations,
}: PluginLocalFoldersSettingsProps) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.localFolders(pluginId, companyId),
    queryFn: () => pluginsApi.listLocalFolders(pluginId, companyId),
  });

  const statusByKey = new Map((data?.folders ?? []).map((folder) => [folder.folderKey, folder]));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FolderOpen className="h-4 w-4 text-muted-foreground"  data-icon="inline-start"/>
        <h3 className="text-sm font-medium">Local folders</h3>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {(error as Error).message || "Failed to load local folder settings."}
          </AlertDescription>
        </Alert>
      ) : null}
      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground" role="status">
          <Spinner className="h-4 w-4" />
          Loading local folders...
        </div>
      ) : (
        <ItemGroup className="gap-3">
          {declarations.map((declaration) => (
            <PluginLocalFolderRow
              key={declaration.folderKey}
              pluginId={pluginId}
              companyId={companyId}
              declaration={declaration}
              status={statusByKey.get(declaration.folderKey)}
            />
          ))}
        </ItemGroup>
      )}
    </div>
  );
}

interface PluginLocalFolderRowProps {
  pluginId: string;
  companyId: string;
  declaration: PluginLocalFolderDeclaration;
  status?: PluginLocalFolderStatus;
}

function PluginLocalFolderRow({ pluginId, companyId, declaration, status }: PluginLocalFolderRowProps) {
  const queryClient = useQueryClient();
  const serverPath = status?.path ?? "";
  const [pathValue, setPathValue] = useState(serverPath);
  const [message, setMessage] = useState<PluginOperationResult | null>(null);

  useEffect(() => {
    setPathValue(serverPath);
    setMessage(null);
  }, [serverPath, declaration.folderKey]);

  const saveMutation = useMutation({
    mutationFn: (path: string) =>
      pluginsApi.configureLocalFolder(pluginId, companyId, declaration.folderKey, {
        path,
      }),
    onSuccess: (nextStatus) => {
      setMessage({
        type: nextStatus.healthy ? "success" : "error",
        text: nextStatus.healthy
          ? "Local folder saved."
          : "Local folder saved, but validation still needs attention.",
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.plugins.localFolders(pluginId, companyId),
      });
    },
    onError: (err: Error) => {
      setMessage({
        type: "error",
        text: err.message || "Failed to save local folder.",
      });
    },
  });

  const isDirty = pathValue !== serverPath;
  const access = status?.access ?? declaration.access ?? "readWrite";
  const statusMetrics = [
    {
      label: "Configured",
      value: status?.configured ? "Yes" : "No",
      ok: !!status?.configured,
    },
    {
      label: "Readable",
      value: status?.readable ? "Yes" : "No",
      ok: !!status?.readable,
    },
    {
      label: "Writable",
      value: access === "read" ? "Not requested" : status?.writable ? "Yes" : "No",
      ok: access === "read" || !!status?.writable,
    },
  ];

  const handleSave = useCallback(() => {
    if (pathValue.length === 0) {
      setMessage({ type: "error", text: "Local folder path is required." });
      return;
    }
    if (pathValue !== pathValue.trim()) {
      setMessage({
        type: "error",
        text: "Local folder path must not contain surrounding whitespace.",
      });
      return;
    }
    if (!isLikelyAbsolutePath(pathValue)) {
      setMessage({
        type: "error",
        text: "Local folder must be a full absolute path.",
      });
      return;
    }
    setMessage(null);
    saveMutation.mutate(pathValue);
  }, [pathValue, saveMutation]);

  return (
    <Item variant="outline" className="items-stretch">
      {saveMutation.isPending ? (
        <p className="sr-only" role="status">
          Saving local folder configuration.
        </p>
      ) : null}
      <ItemHeader>
        <ItemContent>
          <ItemTitle className="flex-wrap">
            {declaration.displayName}
            <Badge variant="outline" className="font-mono text-(length:--text-nano)">
              {declaration.folderKey}
            </Badge>
            <DomainStatus status={status?.healthy ? "healthy" : "needs_attention"}>
              {status?.healthy ? "Healthy" : "Needs attention"}
            </DomainStatus>
          </ItemTitle>
          {declaration.description ? (
            <ItemDescription className="max-w-3xl">{declaration.description}</ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          <Badge variant={access === "readWrite" ? "default" : "outline"}>
            {access === "readWrite" ? "Read/write" : "Read only"}
          </Badge>
        </ItemActions>
      </ItemHeader>

      <ItemContent className="basis-full gap-4">
        <ItemGroup className="grid gap-3 text-sm sm:grid-cols-3">
          {statusMetrics.map((metric) => (
            <Item key={metric.label} variant="muted" size="sm">
              <ItemDescription>{metric.label}</ItemDescription>
              <DomainStatus status={metric.ok ? "healthy" : "disabled"} className="ml-auto">
                {metric.value}
              </DomainStatus>
            </Item>
          ))}
        </ItemGroup>

        <LabeledFormField
          label="Local folder path"
          labelFor={`local-folder-${declaration.folderKey}`}
          description={
            status?.path ? (
              <span className="break-all font-mono text-xs">Configured: {status.path}</span>
            ) : undefined
          }
        >
          <div className="flex items-center gap-2">
            <Input
              id={`local-folder-${declaration.folderKey}`}
              aria-label="Local folder path"
              className="min-w-0 flex-1 font-mono"
              value={pathValue}
              onChange={(event) => {
                setPathValue(event.target.value);
                setMessage(null);
              }}
              placeholder="/absolute/path/to/folder"
            />
            <ChoosePathButton className="h-8" />
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saveMutation.isPending || !isDirty || !companyId}
            >
              {saveMutation.isPending ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Save className="h-3.5 w-3.5"  data-icon="inline-start"/>
              )}
              Save
            </Button>
          </div>
        </LabeledFormField>

        <FolderRequirements status={status} declaration={declaration} />

        {status?.problems?.length ? (
          <Alert variant="destructive">
            <AlertTitle>Validation problems</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {status.problems.map((problem, index) => (
                  <li key={`${problem.code}:${problem.path ?? ""}:${index}`}>
                    {problem.message}
                    {problem.path ? <span className="font-mono"> {problem.path}</span> : null}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {message ? (
          <Alert
            role={message.type === "success" ? "status" : "alert"}
            variant={message.type === "error" ? "destructive" : "default"}
          >
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        ) : null}
      </ItemContent>
    </Item>
  );
}

function FolderRequirements({
  status,
  declaration,
}: {
  status?: PluginLocalFolderStatus;
  declaration: PluginLocalFolderDeclaration;
}) {
  const requiredDirectories = status?.requiredDirectories ?? declaration.requiredDirectories ?? [];
  const requiredFiles = status?.requiredFiles ?? declaration.requiredFiles ?? [];
  const missingDirectories = status?.missingDirectories ?? requiredDirectories;
  const missingFiles = status?.missingFiles ?? requiredFiles;
  const rootNotInspected = isRootNotInspected(status);

  if (requiredDirectories.length === 0 && requiredFiles.length === 0) return null;

  return (
    <div className="grid gap-3 text-sm md:grid-cols-2">
      <RequirementList
        title="Required directories"
        items={requiredDirectories}
        missingItems={missingDirectories}
        missingLabel="Missing directories"
        inspectionUnavailable={rootNotInspected}
      />
      <RequirementList
        title="Required files"
        items={requiredFiles}
        missingItems={missingFiles}
        missingLabel="Missing files"
        inspectionUnavailable={rootNotInspected}
      />
    </div>
  );
}

function isRootNotInspected(status?: PluginLocalFolderStatus) {
  if (!status?.configured || status.readable) return false;
  return status.problems.some(
    (problem) =>
      problem.code === "missing" || problem.code === "not_readable" || problem.code === "not_directory",
  );
}

function RequirementList({
  title,
  items,
  missingItems,
  missingLabel,
  inspectionUnavailable,
}: {
  title: string;
  items: string[];
  missingItems: string[];
  missingLabel: string;
  inspectionUnavailable?: boolean;
}) {
  return (
    <Item variant="outline" size="sm" className="items-stretch">
      <ItemHeader>
        <ItemTitle>{title}</ItemTitle>
        <DomainStatus
          status={inspectionUnavailable ? "unchecked" : missingItems.length > 0 ? "missing" : "ready"}
        >
          {inspectionUnavailable
            ? "Not inspected"
            : missingItems.length > 0
              ? `${missingItems.length} missing`
              : "Present"}
        </DomainStatus>
      </ItemHeader>
      <ItemContent className="basis-full">
        {items.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {items.map((item) => {
              const missing = missingItems.includes(item);
              return (
                <DomainStatus
                  key={item}
                  status={inspectionUnavailable ? "unchecked" : missing ? "missing" : "ready"}
                  className="font-mono text-(length:--text-micro)"
                >
                  {item}
                </DomainStatus>
              );
            })}
          </div>
        ) : (
          <ItemDescription>None declared.</ItemDescription>
        )}
        {inspectionUnavailable || missingItems.length > 0 ? (
          <Alert variant={inspectionUnavailable ? "default" : "destructive"}>
            <AlertDescription>
              {inspectionUnavailable
                ? "Configured root was not inspected."
                : `${missingLabel}: ${missingItems.join(", ")}`}
            </AlertDescription>
          </Alert>
        ) : null}
      </ItemContent>
    </Item>
  );
}

function isLikelyAbsolutePath(pathValue: string) {
  return pathValue.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith("\\\\");
}
