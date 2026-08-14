import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { SecretProvider, SecretStatus } from "@paperclipai/shared";
import { Cloud, Filter, Folder, Info, Plus, Search, X } from "lucide-react";
import { useSecretsPage } from "./-SecretsPageContext";
import type { ProvidedByFilter } from "./-secrets-model";

export function SecretsToolbar() {
  const {
    activeSecretFilterCount,
    closeNewFolder,
    effectiveViewMode,
    newFolderError,
    newFolderName,
    newFolderOpen,
    openCreateSecret,
    openImportFromVault,
    providedByFilter,
    providerConfigs,
    providerFilter,
    providers,
    search,
    searching,
    setActiveTab,
    setNewFolderError,
    setNewFolderName,
    setNewFolderOpen,
    setProvidedByFilter,
    setProviderFilter,
    setSearch,
    setStatusFilter,
    setViewMode,
    showFolderView,
    stageNewFolder,
    statusFilter,
  } = useSecretsPage();
  const awsProviderConfigs = providerConfigs.filter((config) => config.provider === "aws_secrets_manager");
  const canImportFromAwsVault = awsProviderConfigs.some(
    (config) => config.status === "ready" || config.status === "warning",
  );
  const filterGroups: Array<{
    key: "status" | "provided-by" | "provider";
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
  }> = [
    {
      key: "status",
      label: "Status",
      value: statusFilter,
      options: [
        { value: "active", label: "Active" },
        { value: "all", label: "All statuses" },
        { value: "disabled", label: "Disabled" },
        { value: "archived", label: "Archived" },
      ],
    },
    {
      key: "provided-by",
      label: "Provided by",
      value: providedByFilter,
      options: [
        { value: "all", label: "All sources" },
        { value: "company", label: "Company" },
        { value: "user", label: "Each user" },
      ],
    },
    {
      key: "provider",
      label: "Provider",
      value: providerFilter,
      options: [
        { value: "all", label: "All providers" },
        ...providers.map(({ id: value, label }) => ({ value, label })),
      ],
    },
  ];
  return (
    <>
      <Alert role="note">
        <Info />
        <AlertTitle>Use secrets by binding them to runtime environment variables.</AlertTitle>
        <AlertDescription>
          <p>
            Create or link a secret here, then open an agent&apos;s Environment variables or a project&apos;s
            Env field. Add the env key the process expects, for example{" "}
            <code className="font-mono">GH_TOKEN</code>, choose{" "}
            <span className="font-medium text-foreground">Secret</span>, and select the stored secret version.
          </p>
          <p>
            Paperclip resolves the value server-side when the run starts and injects it as that env var.
            Project env applies to every task in the project and overrides agent env on matching keys.
          </p>
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="w-48 sm:w-64 md:w-80">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, key, ref"
            className="text-xs sm:text-sm"
            aria-label="Search secrets"
            data-page-search-target="true"
          />
        </InputGroup>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              className="relative"
              title={activeSecretFilterCount > 0 ? `Filters: ${activeSecretFilterCount}` : "Filter"}
            >
              <Filter className="h-3.5 w-3.5" />
              {activeSecretFilterCount > 0 ? (
                <Badge className="absolute -right-1 -top-1">{activeSecretFilterCount}</Badge>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="max-h-(--sz-calc-42) w-(--sz-calc-41) overflow-y-auto overscroll-contain p-0"
          >
            <div className="space-y-3 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Filters</span>
                {activeSecretFilterCount > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setStatusFilter("active");
                      setProviderFilter("all");
                      setProvidedByFilter("all");
                    }}
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </Button>
                ) : null}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {filterGroups.map((group) => (
                  <FieldSet key={group.key}>
                    <FieldLegend variant="label">{group.label}</FieldLegend>
                    <FieldGroup>
                      {group.options.map((option) => {
                        const id = `secret-filter-${group.key}-${option.value}`;
                        return (
                          <Field key={option.value} orientation="horizontal">
                            <Checkbox
                              id={id}
                              checked={group.value === option.value}
                              onCheckedChange={() => {
                                if (group.key === "status") {
                                  setStatusFilter(option.value as SecretStatus | "all");
                                } else if (group.key === "provider") {
                                  setProviderFilter(option.value as SecretProvider | "all");
                                } else {
                                  setProvidedByFilter(option.value as ProvidedByFilter);
                                }
                              }}
                            />
                            <FieldLabel htmlFor={id}>{option.label}</FieldLabel>
                          </Field>
                        );
                      })}
                    </FieldGroup>
                  </FieldSet>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <ToggleGroup
          type="single"
          value={effectiveViewMode}
          onValueChange={(mode) => {
            if (mode) setViewMode(mode as "folders" | "flat");
          }}
          aria-label="View mode"
          variant="outline"
          size="sm"
          className={cn(searching && "opacity-50")}
        >
          {(["folders", "flat"] as const).map((mode) => (
            <ToggleGroupItem
              key={mode}
              value={mode}
              disabled={searching}
              className="h-7 px-2.5 text-xs capitalize"
            >
              {mode}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {awsProviderConfigs.length === 0 ? null : canImportFromAwsVault ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => openImportFromVault()}
            className="ml-auto"
            data-testid="import-from-vault-button"
          >
            <Cloud data-icon="inline-start" className="mr-1 h-3.5 w-3.5" />
            Import from vault
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActiveTab("vaults")}
            className="ml-auto text-xs text-muted-foreground"
            title="Configure an AWS provider vault to enable remote import"
          >
            <Cloud data-icon="inline-start" className="mr-1 h-3.5 w-3.5" />
            AWS vault disabled — manage
          </Button>
        )}
        {showFolderView ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setNewFolderOpen(true);
              setNewFolderError(null);
            }}
          >
            <Folder data-icon="inline-start" className="mr-1 h-3.5 w-3.5" /> New folder
          </Button>
        ) : null}
        <Button onClick={openCreateSecret} size="sm">
          <Plus data-icon="inline-start" className="h-3.5 w-3.5 mr-1" /> New secret
        </Button>
      </div>
      {newFolderOpen && showFolderView ? (
        <ButtonGroup className="flex flex-wrap items-start gap-2" aria-label="Create folder">
          <div className="min-w-48 flex-1 sm:max-w-80">
            <Input
              value={newFolderName}
              onChange={(event) => {
                setNewFolderName(event.target.value);
                if (newFolderError) setNewFolderError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") stageNewFolder();
                if (event.key === "Escape") closeNewFolder();
              }}
              placeholder="Folder name"
              aria-label="Folder name"
              aria-invalid={Boolean(newFolderError)}
              aria-describedby={newFolderError ? "new-folder-name-error" : undefined}
              autoFocus
            />
            {newFolderError ? <FieldError id="new-folder-name-error">{newFolderError}</FieldError> : null}
          </div>
          <Button type="button" size="sm" onClick={stageNewFolder}>
            Create folder
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={closeNewFolder}>
            Cancel
          </Button>
        </ButtonGroup>
      ) : null}
    </>
  );
}
