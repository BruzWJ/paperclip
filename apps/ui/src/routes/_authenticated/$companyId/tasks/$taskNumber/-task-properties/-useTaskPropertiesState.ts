import { useEffect, useState } from "react";
import type { Task } from "@paperclipai/shared";

export function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function useTaskPropertiesState(task: Task) {
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [ownerSearch, setOwnerSearch] = useState("");
  const [pendingOwner, setPendingOwner] = useState<{
    ownerAgentId: string;
    label: string;
    track?: () => void;
  } | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [blockedByOpen, setBlockedByOpen] = useState(false);
  const [blockedBySearch, setBlockedBySearch] = useState("");
  const [blockedByExpanded, setBlockedByExpanded] = useState(false);
  const [blockingExpanded, setBlockingExpanded] = useState(false);
  const [relatedTasksExpanded, setRelatedTasksExpanded] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const [parentSearch, setParentSearch] = useState("");
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [approversOpen, setApproversOpen] = useState(false);
  const [approverSearch, setApproverSearch] = useState("");
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [monitorDetailsOpen, setMonitorDetailsOpen] = useState(false);
  const [monitorAtInput, setMonitorAtInput] = useState(() =>
    toDateTimeLocalValue(task.executionPolicy?.monitor?.nextCheckAt),
  );
  const [monitorNotesInput, setMonitorNotesInput] = useState(task.executionPolicy?.monitor?.notes ?? "");
  const [monitorServiceInput, setMonitorServiceInput] = useState(
    task.executionPolicy?.monitor?.serviceName ?? "",
  );
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");
  const [unarchiveErrorMessage, setUnarchiveErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setBlockedByExpanded(false);
    setBlockingExpanded(false);
    setRelatedTasksExpanded(false);
  }, [task.id]);

  useEffect(() => {
    setMonitorAtInput(toDateTimeLocalValue(task.executionPolicy?.monitor?.nextCheckAt));
    setMonitorNotesInput(task.executionPolicy?.monitor?.notes ?? "");
    setMonitorServiceInput(task.executionPolicy?.monitor?.serviceName ?? "");
  }, [
    task.executionPolicy?.monitor?.nextCheckAt,
    task.executionPolicy?.monitor?.notes,
    task.executionPolicy?.monitor?.serviceName,
  ]);

  return {
    ownerOpen,
    setOwnerOpen,
    ownerSearch,
    setOwnerSearch,
    pendingOwner,
    setPendingOwner,
    projectOpen,
    setProjectOpen,
    projectSearch,
    setProjectSearch,
    blockedByOpen,
    setBlockedByOpen,
    blockedBySearch,
    setBlockedBySearch,
    blockedByExpanded,
    setBlockedByExpanded,
    blockingExpanded,
    setBlockingExpanded,
    relatedTasksExpanded,
    setRelatedTasksExpanded,
    parentOpen,
    setParentOpen,
    parentSearch,
    setParentSearch,
    reviewersOpen,
    setReviewersOpen,
    reviewerSearch,
    setReviewerSearch,
    approversOpen,
    setApproversOpen,
    approverSearch,
    setApproverSearch,
    monitorOpen,
    setMonitorOpen,
    monitorDetailsOpen,
    setMonitorDetailsOpen,
    monitorAtInput,
    setMonitorAtInput,
    monitorNotesInput,
    setMonitorNotesInput,
    monitorServiceInput,
    setMonitorServiceInput,
    labelsOpen,
    setLabelsOpen,
    labelSearch,
    setLabelSearch,
    newLabelName,
    setNewLabelName,
    newLabelColor,
    setNewLabelColor,
    unarchiveErrorMessage,
    setUnarchiveErrorMessage,
  };
}

export type TaskPropertiesState = ReturnType<typeof useTaskPropertiesState>;
