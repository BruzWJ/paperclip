import {
  AdapterPickerList,
  ConflictResolutionList,
  importActionBadgeVariant,
  renderImportFileExtra,
} from "@/components/company/CompanyImportControls";
import { CompanyPortabilityFilePreview } from "@/components/CompanyPortabilityFilePreview";
import { FileTree } from "@/components/FileTree";
import {
  Choicebox,
  ChoiceboxIndicator,
  ChoiceboxItem,
  ChoiceboxItemHeader,
  ChoiceboxItemTitle,
} from "@/components/kibo-ui/choicebox";
import { AccessibleDropzone } from "@/components/patterns/AccessibleDropzone";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as ItemUI from "@/components/ui/item";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CompanyImportController } from "@/routes/_authenticated/$companyId/company/import/-useCompanyImportController";
import type { CompanyPortabilityCollisionStrategy } from "@paperclipai/shared";
import { Download, Github, Upload } from "lucide-react";
import { toast } from "sonner";

interface CompanyImportViewProps {
  controller: CompanyImportController;
}

export function CompanyImportView({ controller }: CompanyImportViewProps) {
  const {
    adapterAgents,
    adapterConfigValues,
    adapterExpandedSlugs,
    adapterOverrides,
    checkedFiles,
    collisionStrategy,
    confirmedSlugs,
    conflicts,
    expandedDirs,
    fileTones,
    handleAdapterChange,
    handleAdapterConfigChange,
    handleAdapterToggleExpand,
    handleChooseLocalPackage,
    handleConflictRename,
    handleConflictToggleConfirm,
    handleConflictToggleSkip,
    handleToggleCheck,
    handleToggleDir,
    hasErrors,
    hasSource,
    importMutation,
    importPreview,
    importUrl,
    localPackage,
    localPackageFile,
    localZipHelpText,
    nameOverrides,
    newCompanyName,
    previewContent,
    previewMutation,
    renameMap,
    selectedAction,
    selectedCompany,
    selectedCount,
    selectedFile,
    selectedRenamedTo,
    setCollisionStrategy,
    setImportPreview,
    setImportUrl,
    setNewCompanyName,
    setSelectedFile,
    setSourceMode,
    setTargetMode,
    skippedSlugs,
    sourceMode,
    targetMode,
    totalFiles,
    tree,
  } = controller;

  return (
    <div>
      {/* Source form section */}
      <div className="border-b border-border px-5 py-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Import source</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Choose a GitHub repo or upload a local Paperclip zip package.
          </p>
        </div>

        <Choicebox
          value={sourceMode}
          className="grid gap-2 md:grid-cols-2"
          onValueChange={(value) => {
            if (!value) return;
            setSourceMode(value as "github" | "local");
            setImportPreview(null);
          }}
        >
          {(
            [
              { key: "github", icon: Github, label: "GitHub repo" },
              { key: "local", icon: Upload, label: "Local zip" },
            ] as const
          ).map(({ key, icon: Icon, label }) => (
            <ChoiceboxItem key={key} id={`company-import-source-${key}`} value={key}>
              <Icon />
              <ChoiceboxItemHeader>
                <ChoiceboxItemTitle>{label}</ChoiceboxItemTitle>
              </ChoiceboxItemHeader>
              <ChoiceboxIndicator id={`company-import-source-${key}`} />
            </ChoiceboxItem>
          ))}
        </Choicebox>

        {sourceMode === "local" ? (
          <LabeledFormField
            label="Company package"
            description={
              localPackage
                ? `${Object.keys(localPackage.files).length} file${
                    Object.keys(localPackage.files).length === 1 ? "" : "s"
                  } found in ${localPackage.name}.`
                : localZipHelpText
            }
          >
            <AccessibleDropzone
              accept={{ "application/zip": [".zip"] }}
              ariaLabel="Upload company package"
              maxFiles={1}
              src={localPackageFile ? [localPackageFile] : undefined}
              onDrop={(files) => {
                const file = files[0];
                if (file) void handleChooseLocalPackage(file);
              }}
              onError={(error) => toast.error("Package rejected", { description: error.message })}
            />
          </LabeledFormField>
        ) : (
          <LabeledFormField
            label="GitHub URL"
            description="Exact HTTPS repository URL with required ref and optional package path."
          >
            <Input
              aria-label="GitHub repository URL"
              type="text"
              value={importUrl}
              placeholder="https://github.com/paperclipai/companies?ref=main&path=gstack%2Fengineering"
              onChange={(e) => {
                setImportUrl(e.target.value);
                setImportPreview(null);
              }}
            />
          </LabeledFormField>
        )}

        <LabeledFormField label="Target" description="Import into this company or create a new one.">
          <Select
            value={targetMode}
            onValueChange={(v) => {
              setTargetMode(v as "existing" | "new");
              setImportPreview(null);
            }}
          >
            <SelectTrigger
              aria-label="Import target"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">Create new company</SelectItem>
              <SelectItem value="existing">Existing company: {selectedCompany?.name}</SelectItem>
            </SelectContent>
          </Select>
        </LabeledFormField>

        {targetMode === "new" && (
          <LabeledFormField
            label="New company name"
            description="Optional override. Leave blank to use the package name."
          >
            <Input
              aria-label="New company name"
              type="text"
              value={newCompanyName}
              onChange={(e) => setNewCompanyName(e.target.value)}
              placeholder="Imported Company"
            />
          </LabeledFormField>
        )}

        <LabeledFormField
          label="Collision strategy"
          description="Board imports can rename, skip, or replace matching company content."
        >
          <Select
            value={collisionStrategy}
            onValueChange={(v) => {
              setCollisionStrategy(v as CompanyPortabilityCollisionStrategy);
              setImportPreview(null);
            }}
          >
            <SelectTrigger
              aria-label="Collision strategy"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rename">Rename on conflict</SelectItem>
              <SelectItem value="skip">Skip on conflict</SelectItem>
              <SelectItem value="replace">Replace existing</SelectItem>
            </SelectContent>
          </Select>
        </LabeledFormField>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || !hasSource}
          >
            {previewMutation.isPending ? "Previewing..." : "Preview import"}
          </Button>
        </div>
      </div>

      {/* Preview results */}
      {importPreview && (
        <>
          {/* Sticky import action bar */}
          <div className="sticky top-0 z-10 border-b border-border bg-background px-5 py-3">
            <ItemUI.Item size="sm" className="border-0 p-0">
              <ItemUI.ItemContent>
                <ItemUI.ItemTitle>Import preview</ItemUI.ItemTitle>
                <ItemUI.ItemDescription>
                  {selectedCount} / {totalFiles} file
                  {totalFiles === 1 ? "" : "s"} selected
                </ItemUI.ItemDescription>
              </ItemUI.ItemContent>
              <ItemUI.ItemActions className="flex-wrap">
                {conflicts.length > 0 && (
                  <Badge variant="secondary">
                    {conflicts.length} conflict
                    {conflicts.length === 1 ? "" : "s"}
                  </Badge>
                )}
                {importPreview.errors.length > 0 && (
                  <Badge variant="destructive">
                    {importPreview.errors.length} error
                    {importPreview.errors.length === 1 ? "" : "s"}
                  </Badge>
                )}
              </ItemUI.ItemActions>
            </ItemUI.Item>
          </div>

          {/* Conflict resolution list */}
          <ConflictResolutionList
            conflicts={conflicts}
            nameOverrides={nameOverrides}
            skippedSlugs={skippedSlugs}
            confirmedSlugs={confirmedSlugs}
            onRename={handleConflictRename}
            onToggleSkip={handleConflictToggleSkip}
            onToggleConfirm={handleConflictToggleConfirm}
          />

          {/* Adapter picker list */}
          <AdapterPickerList
            agents={adapterAgents}
            adapterOverrides={adapterOverrides}
            expandedSlugs={adapterExpandedSlugs}
            configValues={adapterConfigValues}
            onChangeAdapter={handleAdapterChange}
            onToggleExpand={handleAdapterToggleExpand}
            onChangeConfig={handleAdapterConfigChange}
          />

          {/* Import button — below renames */}
          <div className="mx-5 mt-3 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending || hasErrors || selectedCount === 0}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {importMutation.isPending
                ? "Importing..."
                : `Import ${selectedCount} file${selectedCount === 1 ? "" : "s"}`}
            </Button>
          </div>

          {/* Warnings */}
          {importPreview.warnings.length > 0 && (
            <Alert className="mx-5 mt-3">
              <AlertDescription>
                {importPreview.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </AlertDescription>
            </Alert>
          )}

          {/* Errors */}
          {importPreview.errors.length > 0 && (
            <Alert variant="destructive" className="mx-5 mt-3">
              <AlertDescription>
                {importPreview.errors.map((error) => (
                  <p key={error}>{error}</p>
                ))}
              </AlertDescription>
            </Alert>
          )}

          {/* Two-column layout */}
          <div className="grid gap-4 xl:h-(--sz-calc-31) xl:grid-cols-(--gtc-25) xl:gap-0">
            <aside className="flex max-h-(--sz-24rem) flex-col overflow-hidden border-b border-border xl:max-h-none xl:border-b-0 xl:border-r">
              <div className="border-b border-border px-4 py-3 shrink-0">
                <h2 className="text-base font-semibold">Package files</h2>
              </div>
              <div className="flex-1 overflow-y-auto">
                <FileTree
                  nodes={tree}
                  selectedFile={selectedFile}
                  expandedDirs={expandedDirs}
                  checkedFiles={checkedFiles}
                  onToggleDir={handleToggleDir}
                  onSelectFile={setSelectedFile}
                  onToggleCheck={handleToggleCheck}
                  renderFileExtra={(node, checked) => renderImportFileExtra(node, checked, renameMap)}
                  fileTones={fileTones}
                  wrapLabels={false}
                />
              </div>
            </aside>
            <div className="min-w-0 overflow-y-auto xl:pl-6">
              <CompanyPortabilityFilePreview
                selectedFile={selectedFile}
                content={previewContent}
                allFiles={importPreview?.files ?? {}}
                header={
                  selectedFile ? (
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-sm">{selectedFile}</span>
                        {selectedRenamedTo ? (
                          <span className="shrink-0 font-mono text-sm text-muted-foreground">
                            &rarr; {selectedRenamedTo}
                          </span>
                        ) : null}
                      </div>
                      {selectedAction ? (
                        <Badge variant={importActionBadgeVariant(selectedAction)}>{selectedAction}</Badge>
                      ) : null}
                    </div>
                  ) : undefined
                }
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
