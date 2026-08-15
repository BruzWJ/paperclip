import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { AlertTriangle, Info, X } from "lucide-react";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

import { type DraftSelection, middleTruncate, normalizeDraftKey } from "./-VaultImportUtils";

interface ReviewStepProps {
  drafts: DraftSelection[];
  reviewErrors: Map<string, string>;
  updateDraft: (externalRef: string, patch: Partial<DraftSelection>) => void;
  removeDraft: (externalRef: string) => void;
  importing: boolean;
}

export function ReviewStep({ drafts, reviewErrors, updateDraft, removeDraft, importing }: ReviewStepProps) {
  if (drafts.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Info />
            </EmptyMedia>
            <EmptyTitle>No secrets selected. Go back to pick remote secrets to import.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const blocked = reviewErrors.size;
  const ready = drafts.length - blocked;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Alert>
        <AlertDescription>
          {ready} secrets ready to import
          {blocked > 0 && (
            <DomainStatus status="blocked">{blocked} need attention before import</DomainStatus>
          )}
        </AlertDescription>
      </Alert>
      <ItemGroup data-testid="review-list">
        {drafts.map((draft) => {
          const error = reviewErrors.get(draft.candidate.externalRef);
          const errorId = `review-error-${draft.candidate.externalRef}`;
          return (
            <Item
              key={draft.candidate.externalRef}
              variant="outline"
              data-testid={`review-row-${draft.candidate.externalRef}`}
            >
              <ItemContent>
                <ItemTitle>{draft.candidate.remoteName}</ItemTitle>
                <ItemDescription title={draft.candidate.externalRef}>
                  {middleTruncate(draft.candidate.externalRef, 60)}
                </ItemDescription>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <LabeledFormField label="Paperclip name">
                    <Input
                      value={draft.name}
                      onChange={(e) =>
                        updateDraft(draft.candidate.externalRef, {
                          name: e.target.value,
                        })
                      }
                      className="text-xs"
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? errorId : undefined}
                      disabled={importing}
                      data-testid={`review-name-${draft.candidate.externalRef}`}
                    />
                  </LabeledFormField>
                  <LabeledFormField label="Key">
                    <Input
                      value={draft.key}
                      onChange={(e) =>
                        updateDraft(draft.candidate.externalRef, {
                          key: e.target.value,
                        })
                      }
                      onBlur={(e) =>
                        updateDraft(draft.candidate.externalRef, {
                          key: normalizeDraftKey(e.target.value),
                        })
                      }
                      className="font-mono text-xs"
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? errorId : undefined}
                      disabled={importing}
                      data-testid={`review-key-${draft.candidate.externalRef}`}
                    />
                  </LabeledFormField>
                  <LabeledFormField label="Description (optional)">
                    <Input
                      value={draft.description}
                      onChange={(e) =>
                        updateDraft(draft.candidate.externalRef, {
                          description: e.target.value,
                        })
                      }
                      className="text-xs"
                      disabled={importing}
                      data-testid={`review-description-${draft.candidate.externalRef}`}
                    />
                  </LabeledFormField>
                </div>
                {error && (
                  <FieldError id={errorId} data-testid={`review-error-${draft.candidate.externalRef}`}>
                    <AlertTriangle />
                    {error}
                  </FieldError>
                )}
              </ItemContent>
              <ItemActions>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeDraft(draft.candidate.externalRef)}
                  aria-label={`Remove ${draft.candidate.remoteName}`}
                  disabled={importing}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </div>
  );
}
