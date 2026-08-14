import type { ChangeEvent, Dispatch, DragEvent, RefObject, SetStateAction } from "react";
import {
  createUniqueDocumentKey,
  fileBaseName,
  isTextDocumentFile,
  slugifyDocumentKey,
  titleizeFilename,
  type StagedTaskFile,
} from "./model";

export function useStagedTaskFiles({
  setStagedFiles,
  setIsFileDragOver,
  stageFileInputRef,
}: {
  setStagedFiles: Dispatch<SetStateAction<StagedTaskFile[]>>;
  setIsFileDragOver: Dispatch<SetStateAction<boolean>>;
  stageFileInputRef: RefObject<HTMLInputElement | null>;
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

  function handleStageFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    stageFiles(Array.from(event.target.files ?? []));
    if (stageFileInputRef.current) stageFileInputRef.current.value = "";
  }
  function handleFileDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setIsFileDragOver(true);
  }
  function handleFileDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }
  function handleFileDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsFileDragOver(false);
  }
  function handleFileDrop(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    setIsFileDragOver(false);
    stageFiles(Array.from(event.dataTransfer.files));
  }
  function removeStagedFile(id: string) {
    setStagedFiles((current) => current.filter((file) => file.id !== id));
  }
  return {
    handleStageFilesPicked,
    handleFileDragEnter,
    handleFileDragOver,
    handleFileDragLeave,
    handleFileDrop,
    removeStagedFile,
  };
}
