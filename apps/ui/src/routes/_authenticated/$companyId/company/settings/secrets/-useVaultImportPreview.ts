import { secretsApi } from "@/api/secrets";
import { toast } from "sonner";
import type { RemoteSecretImportCandidate } from "@paperclipai/shared";
import { useCallback, useEffect, useRef, useState } from "react";

const PAGE_SIZE = 50;

type PreviewState = {
  candidates: RemoteSecretImportCandidate[];
  nextToken: string | null;
};

const EMPTY_PREVIEW: PreviewState = { candidates: [], nextToken: null };

interface VaultImportPreviewOptions {
  companyId: string;
  open: boolean;
  query: string;
  step: "select" | "review" | "result";
  vaultId: string | null;
}

export function useVaultImportPreview({ companyId, open, query, step, vaultId }: VaultImportPreviewOptions) {
  const requestIdRef = useRef(0);
  const [preview, setPreview] = useState<PreviewState>(EMPTY_PREVIEW);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);

  const loadPreview = useCallback(async () => {
    if (!vaultId) return;
    const requestId = ++requestIdRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(EMPTY_PREVIEW);
    try {
      const result = await secretsApi.remoteImportPreview(companyId, {
        providerConfigId: vaultId,
        query: query || null,
        nextToken: null,
        pageSize: PAGE_SIZE,
      });
      if (requestId === requestIdRef.current) {
        setPreview({
          candidates: result.candidates,
          nextToken: result.nextToken,
        });
      }
    } catch (error) {
      if (requestId === requestIdRef.current) setPreviewError(error);
    } finally {
      if (requestId === requestIdRef.current) setPreviewLoading(false);
    }
  }, [companyId, query, vaultId]);

  useEffect(() => {
    if (!open || step !== "select" || !vaultId) return;
    void loadPreview();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadPreview, open, step, vaultId]);

  const resetPreview = useCallback(() => {
    requestIdRef.current += 1;
    setPreview(EMPTY_PREVIEW);
    setPreviewError(null);
  }, []);

  const loadMore = useCallback(async () => {
    if (!vaultId || !preview.nextToken || pageLoading) return;
    setPageLoading(true);
    try {
      const result = await secretsApi.remoteImportPreview(companyId, {
        providerConfigId: vaultId,
        query: query || null,
        nextToken: preview.nextToken,
        pageSize: PAGE_SIZE,
      });
      setPreview((current) => {
        const seen = new Set(current.candidates.map((candidate) => candidate.externalRef));
        const candidates = [...current.candidates];
        for (const candidate of result.candidates) {
          if (!seen.has(candidate.externalRef)) candidates.push(candidate);
        }
        return { candidates, nextToken: result.nextToken };
      });
    } catch (error) {
      toast.error("Could not load more results", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setPageLoading(false);
    }
  }, [companyId, pageLoading, preview.nextToken, query, toast, vaultId]);

  return {
    loadMore,
    pageLoading,
    preview,
    previewError,
    previewLoading,
    refresh: loadPreview,
    resetPreview,
  };
}
