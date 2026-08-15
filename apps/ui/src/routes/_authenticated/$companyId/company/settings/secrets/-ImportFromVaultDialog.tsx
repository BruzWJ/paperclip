import { secretsApi, type RemoteImportInput, type RemoteImportSelectionInput } from "@/api/secrets";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { toast } from "sonner";
import { queryKeys } from "@/lib/queryKeys";
import type {
  CompanySecret,
  CompanySecretProviderConfig,
  RemoteSecretImportCandidate,
  RemoteSecretImportResult,
} from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  awsVaultOptions,
  buildDraft,
  type DraftSelection,
  eligibleVaults,
  pickDefaultVault,
  readableErrorMessage,
  safeImportProviderMetadata,
  useDebounced,
  validateDraftRow,
  type VaultImportStep,
} from "./-VaultImportUtils";

import { SelectStep } from "./-VaultImportSelectStep";
import { ReviewStep } from "./-VaultImportReviewStep";
import { FooterStatus, ResultStep } from "./-VaultImportResultStep";
import { useVaultImportPreview } from "./-useVaultImportPreview";

interface ImportFromVaultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  providerConfigs: CompanySecretProviderConfig[];
  existingSecrets: CompanySecret[];
  initialProviderConfigId?: string | null;
  onImportComplete?: (result: RemoteSecretImportResult) => void;
  onManageVaults?: () => void;
}

const VAULT_IMPORT_STEPS: { id: VaultImportStep; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "review", label: "Review" },
  { id: "result", label: "Result" },
];

export function ImportFromVaultDialog({
  open,
  onOpenChange,
  companyId,
  providerConfigs,
  existingSecrets,
  initialProviderConfigId,
  onImportComplete,
  onManageVaults,
}: ImportFromVaultDialogProps) {
  // Async pending contract: disabled={isPending} aria-busy={isPending} role="status" {isPending ? "Saving" : "Save"}
  const queryClient = useQueryClient();
  const awsVaults = useMemo(() => awsVaultOptions(providerConfigs), [providerConfigs]);
  const eligible = useMemo(() => eligibleVaults(providerConfigs), [providerConfigs]);
  const noEligibleVaults = eligible.length === 0;

  const [step, setStep] = useState<VaultImportStep>("select");
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const debouncedQuery = useDebounced(searchInput.trim(), 250);

  const { loadMore, pageLoading, preview, previewError, previewLoading, refresh, resetPreview } =
    useVaultImportPreview({
      companyId,
      open,
      query: debouncedQuery,
      step,
      vaultId,
    });
  const [showOnlySelected, setShowOnlySelected] = useState(false);

  const [selection, setSelection] = useState<Map<string, DraftSelection>>(new Map());
  const [importResult, setImportResult] = useState<RemoteSecretImportResult | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const activeStepIndex = VAULT_IMPORT_STEPS.findIndex(({ id }) => id === step);

  useEffect(() => {
    if (!open) return;
    setStep("select");
    setSearchInput("");
    resetPreview();
    setSelection(new Map());
    setImportResult(null);
    setDiscardOpen(false);
    setShowOnlySelected(false);
    const next = pickDefaultVault(providerConfigs, initialProviderConfigId);
    setVaultId(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setSelection(new Map());
    setShowOnlySelected(false);
  }, [vaultId]);

  const visibleCandidates = useMemo<RemoteSecretImportCandidate[]>(() => {
    if (!showOnlySelected) return preview.candidates;
    return preview.candidates.filter((candidate) => selection.has(candidate.externalRef));
  }, [preview.candidates, selection, showOnlySelected]);

  const selectableInLoaded = useMemo(
    () => preview.candidates.filter((c) => c.importable),
    [preview.candidates],
  );

  const selectableLoadedCount = selectableInLoaded.length;
  const selectedLoadedCount = selectableInLoaded.filter((c) => selection.has(c.externalRef)).length;

  const headerCheckboxState: boolean | "indeterminate" =
    selectableLoadedCount === 0
      ? false
      : selectedLoadedCount === 0
        ? false
        : selectedLoadedCount === selectableLoadedCount
          ? true
          : "indeterminate";

  const totalSelected = selection.size;
  const selectedNotVisible = useMemo(() => {
    if (!debouncedQuery) return 0;
    let count = 0;
    for (const ref of selection.keys()) {
      if (!preview.candidates.some((c) => c.externalRef === ref)) count += 1;
    }
    return count;
  }, [selection, preview.candidates, debouncedQuery]);

  const draftList = useMemo(() => Array.from(selection.values()), [selection]);

  const reviewErrors = useMemo<Map<string, string>>(() => {
    const validationMessages = new Map<string, string>();
    for (const draft of draftList) {
      const error = validateDraftRow(draft, existingSecrets, draftList);
      if (error) validationMessages.set(draft.candidate.externalRef, error);
    }
    return validationMessages;
  }, [draftList, existingSecrets]);

  const blockedReviewCount = reviewErrors.size;
  const readyReviewCount = draftList.length - blockedReviewCount;

  const importMutation = useMutation({
    mutationFn: (input: RemoteImportInput) => secretsApi.remoteImport(companyId, input),
    onSuccess: (result) => {
      setImportResult(result);
      setStep("result");
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(companyId),
      });
      onImportComplete?.(result);
      const vaultName = awsVaults.find((vault) => vault.id === vaultId)?.displayName ?? "AWS";
      if (result.errorCount === draftList.length && result.errorCount > 0) {
        toast.error("Import failed", {
          description: `No secrets were imported from ${vaultName}.`,
        });
      } else {
        const description = `${result.importedCount} created · ${result.skippedCount} skipped · ${result.errorCount} failed`;
        if (result.errorCount > 0) {
          toast.warning("Import completed with errors", { description });
        } else {
          toast.success("Import complete", { description });
        }
      }
    },
    onError: (error) => {
      toast.error("Import failed", {
        description: readableErrorMessage(error),
      });
    },
  });

  function handleVaultChange(nextId: string) {
    setVaultId(nextId);
    setSearchInput("");
  }

  function toggleRow(candidate: RemoteSecretImportCandidate) {
    if (!candidate.importable) return;
    setSelection((prev) => {
      const next = new Map(prev);
      if (next.has(candidate.externalRef)) {
        next.delete(candidate.externalRef);
      } else {
        next.set(candidate.externalRef, buildDraft(candidate));
      }
      return next;
    });
  }

  function toggleAllLoaded() {
    setSelection((prev) => {
      const next = new Map(prev);
      const allSelected = selectableInLoaded.every((c) => next.has(c.externalRef));
      if (allSelected) {
        for (const candidate of selectableInLoaded) {
          next.delete(candidate.externalRef);
        }
      } else {
        for (const candidate of selectableInLoaded) {
          if (!next.has(candidate.externalRef)) {
            next.set(candidate.externalRef, buildDraft(candidate));
          }
        }
      }
      return next;
    });
  }

  function updateDraft(externalRef: string, patch: Partial<DraftSelection>) {
    setSelection((prev) => {
      const next = new Map(prev);
      const existing = next.get(externalRef);
      if (!existing) return prev;
      next.set(externalRef, { ...existing, ...patch });
      return next;
    });
  }

  function removeDraft(externalRef: string) {
    setSelection((prev) => {
      const next = new Map(prev);
      next.delete(externalRef);
      return next;
    });
  }

  function handleClose(force = false) {
    if (importMutation.isPending) return;
    if (!force && step !== "result" && selection.size > 0 && !importResult) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  }

  function handleSubmitImport() {
    if (!vaultId || importMutation.isPending) return;
    if (blockedReviewCount > 0) return;
    if (draftList.length === 0) return;
    const items: RemoteImportSelectionInput[] = draftList.map((draft) => ({
      externalRef: draft.candidate.externalRef,
      name: draft.name.trim(),
      key: draft.key,
      description: draft.description.trim() || null,
      providerVersionRef: draft.candidate.providerVersionRef,
      providerMetadata: safeImportProviderMetadata(draft.candidate.providerMetadata),
    }));
    importMutation.mutate({ providerConfigId: vaultId, secrets: items });
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            onOpenChange(true);
          } else {
            handleClose();
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex max-h-(--sz-85vh) flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          data-testid="import-from-vault-dialog"
        >
          <DialogHeader className="flex-row items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
            <div className="flex flex-col gap-1">
              <DialogTitle>Import from AWS Secrets Manager</DialogTitle>
              <DialogDescription>
                Bring AWS-managed secrets into Paperclip as external references.
              </DialogDescription>
              <div className="flex items-center gap-2">
                {VAULT_IMPORT_STEPS.map(({ id, label }, index) => (
                  <span key={id} className="flex items-center gap-2">
                    <Badge variant={index <= activeStepIndex ? "default" : "outline"}>{index + 1}</Badge>
                    <span>{label}</span>
                    {index < VAULT_IMPORT_STEPS.length - 1 ? (
                      <span className="text-muted-foreground/60">›</span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => handleClose()}
              aria-label="Close import dialog"
            >
              <X  data-icon="inline-start"/>
            </Button>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-live="polite">
            {step === "select" && (
              <SelectStep
                awsVaults={awsVaults}
                eligible={eligible}
                vaultId={vaultId}
                onVaultChange={handleVaultChange}
                searchInput={searchInput}
                onSearchInput={setSearchInput}
                debouncedQuery={debouncedQuery}
                onRefresh={() => void refresh()}
                previewLoading={previewLoading}
                pageLoading={pageLoading}
                previewError={previewError}
                candidates={preview.candidates}
                visibleCandidates={visibleCandidates}
                selectableInLoaded={selectableInLoaded}
                selection={selection}
                toggleRow={toggleRow}
                toggleAllLoaded={toggleAllLoaded}
                headerCheckboxState={headerCheckboxState}
                hasNextPage={Boolean(preview.nextToken)}
                onLoadMore={() => void loadMore()}
                showOnlySelected={showOnlySelected}
                onShowOnlySelectedChange={setShowOnlySelected}
                selectedNotVisible={selectedNotVisible}
                noEligibleVaults={noEligibleVaults}
                onManageVaults={onManageVaults}
              />
            )}
            {step === "review" && (
              <ReviewStep
                drafts={draftList}
                reviewErrors={reviewErrors}
                updateDraft={updateDraft}
                removeDraft={removeDraft}
                importing={importMutation.isPending}
              />
            )}
            {step === "result" && importResult && <ResultStep result={importResult} draftList={draftList} />}
          </div>

          <DialogFooter className="items-center justify-between border-t border-border/60 bg-muted/20 px-5 py-3 sm:justify-between">
            <FooterStatus
              step={step}
              totalSelected={totalSelected}
              readyReviewCount={readyReviewCount}
              blockedReviewCount={blockedReviewCount}
              result={importResult}
            />
            <div className="flex items-center gap-2">
              {step !== "result" ? (
                <Button variant="ghost" size="sm" onClick={() => handleClose()}>
                  Cancel
                </Button>
              ) : null}
              {step === "review" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStep("select")}
                  disabled={importMutation.isPending}
                >
                  Back
                </Button>
              ) : null}
              {step === "select" ? (
                <Button size="sm" onClick={() => setStep("review")} disabled={totalSelected === 0}>
                  Continue → Review
                </Button>
              ) : null}
              {step === "review" ? (
                <Button
                  size="sm"
                  onClick={handleSubmitImport}
                  disabled={draftList.length === 0 || blockedReviewCount > 0 || importMutation.isPending}
                >
                  {importMutation.isPending ? (
                    <>
                      <Spinner /> Importing…
                    </>
                  ) : (
                    `Import ${draftList.length}`
                  )}
                </Button>
              ) : null}
              {step === "result" ? (
                <Button size="sm" onClick={() => handleClose(true)}>
                  Done
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard pending imports?"
        description={
          <>
            Your {selection.size} pending import
            {selection.size === 1 ? "" : "s"} will not be saved.
          </>
        }
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        variant="destructive"
        onConfirm={() => handleClose(true)}
      />
    </>
  );
}
