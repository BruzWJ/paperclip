import type { Dispatch, SetStateAction } from "react";
import { fileBaseName, slugifyDocumentKey, titleizeFilename } from "@/lib/document-file-names";
import { createUniqueDocumentKey, isTextDocumentFile, type StagedTaskFile } from "./model";

export function useStagedTaskFiles({
  setStagedFiles,
}: {
  setStagedFiles: Dispatch<SetStateAction<StagedTaskFile[]>>;
}) {
  function stageFiles(files: File[]) {
    if (files.length === 0) return;
    setStagedFiles((current) => {
      const next = [...current];
      for (const file of files) {
        if (isTextDocumentFile(file)) {
          const baseName = fileBaseName(file.name);
          const documentKey = createUniqueDocumentKey(slugifyDocumentKey(baseName), next);
          next.push({
            id: `${file.name}:${file.size}:${file.lastModified}:${documentKey}`,
            file,
            kind: "document",
            documentKey,
            title: titleizeFilename(baseName),
          });
          continue;
        }
        next.push({
          id: `${file.name}:${file.size}:${file.lastModified}`,
          file,
          kind: "attachment",
        });
      }
      return next;
    });
  }

  function removeStagedFile(id: string) {
    setStagedFiles((current) => current.filter((file) => file.id !== id));
  }
  return {
    stageFiles,
    removeStagedFile,
  };
}
