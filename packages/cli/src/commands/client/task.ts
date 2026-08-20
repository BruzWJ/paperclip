import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  createChildTaskSchema,
  createTaskLabelSchema,
  createTaskSchema,
  createTaskUserCommentSchema,
  createTaskTreeHoldSchema,
  createTaskWorkProductSchema,
  type BoardTaskComment,
  type BoardTaskCommentGroupPage,
  type TaskExecutionRunListPageRecord,
  linkTaskApprovalSchema,
  previewTaskTreeControlSchema,
  releaseTaskTreeHoldSchema,
  restoreTaskDocumentRevisionSchema,
  reassignTaskSchema,
  updateTaskTitleSchema,
  updateTaskWorkProductSchema,
  type Task,
  upsertTaskDocumentSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  inferContentTypeFromPath,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface TaskBaseOptions extends BaseClientOptions {
  status?: string;
  ownerAgentId?: string;
  projectId?: string;
  match?: string;
}

interface TaskCreateOptions extends BaseClientOptions {
  request: string;
  ownerAgentId: string;
  idempotencyKey?: string;
  title?: string;
  priority?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
}

interface TaskTitleOptions extends BaseClientOptions {
  title: string;
}

interface TaskReassignOptions extends BaseClientOptions {
  ownerAgentId: string;
  idempotencyKey?: string;
}

interface TaskCommentOptions extends BaseClientOptions {
  message: string;
  idempotencyKey?: string;
  mentionTargetAgentId?: string;
  mentionOwnershipEpoch?: string;
  replyToCommentId?: string;
}

interface TaskCommentListOptions extends BaseClientOptions {
  cursor?: string;
  limit?: string;
  entryLimit?: string;
}


interface JsonPayloadOptions extends BaseClientOptions {
  payloadJson: string;
}

interface TaskDocumentPutOptions extends BaseClientOptions {
  title?: string;
  format?: string;
  body?: string;
  bodyFile?: string;
  changeSummary?: string;
  baseRevisionId?: string;
}

interface TaskAttachmentUploadOptions extends BaseClientOptions {
  companyId?: string;
  file: string;
  commentId?: string;
}

interface TaskAttachmentDownloadOptions extends BaseClientOptions {
  out?: string;
}

interface TaskLabelCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  color: string;
}

interface TreeHoldListOptions extends BaseClientOptions {
  status?: string;
  mode?: string;
  includeMembers?: boolean;
}

export function registerTaskCommands(program: Command): void {
  const task = program.command("task").description("Task operations");

  addCommonClientOptions(
    task
      .command("list")
      .description("List tasks for a company")
      .option("-C, --company-id <id>", "Company ID")
      .option("--status <csv>", "Comma-separated statuses")
      .option("--owner-agent-id <id>", "Filter by owner agent ID")
      .option("--project-id <id>", "Filter by project ID")
      .option("--match <text>", "Local text match on identifier/title/request")
      .action(async (opts: TaskBaseOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.ownerAgentId) params.set("ownerAgentId", opts.ownerAgentId);
          if (opts.projectId) params.set("projectId", opts.projectId);

          const query = params.toString();
          const path = `${apiPath`/api/companies/${ctx.companyId}/tasks`}${query ? `?${query}` : ""}`;
          const rows = (await ctx.api.get<Task[]>(path)) ?? [];

          const filtered = filterTaskRows(rows, opts.match);
          if (ctx.json) {
            printOutput(filtered, { json: true });
            return;
          }

          if (filtered.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const item of filtered) {
            console.log(
              formatInlineRecord({
                identifier: item.identifier,
                id: item.id,
                boardPresentationStatus: item.boardPresentationStatus,
                priority: item.priority,
                ownerAgentId: item.ownerAgentId,
                title: item.title,
                projectId: item.projectId,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    task
      .command("get")
      .description("Get a task by UUID")
      .argument("<taskId>", "Task UUID")
      .action(async (taskId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Task>(apiPath`/api/tasks/${taskId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("create")
      .description("Create a task")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--request <text>", "Immutable work request")
      .requiredOption("--owner-agent-id <id>", "Agent owner ID")
      .option("--idempotency-key <key>", "Retry key (generated when omitted)")
      .option("--title <title>", "Optional display title")
      .option("--priority <priority>", "Task priority")
      .option("--project-id <id>", "Project ID")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-id <id>", "Parent task ID")
      .action(async (opts: TaskCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createTaskSchema.parse({
            request: opts.request,
            ownerAgentId: opts.ownerAgentId,
            idempotencyKey: opts.idempotencyKey ?? randomUUID(),
            title: opts.title,
            priority: opts.priority,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
          });

          const created = await ctx.api.post<Task>(apiPath`/api/companies/${ctx.companyId}/tasks`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    task
      .command("title")
      .description("Update board-editable task title metadata")
      .argument("<taskId>", "Task ID")
      .requiredOption("--title <title>", "Task title")
      .action(async (taskId: string, opts: TaskTitleOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateTaskTitleSchema.parse({
            title: opts.title,
          });

          const updated = await ctx.api.patch<Task>(apiPath`/api/tasks/${taskId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("reassign")
      .description("Reassign a task through the audited board control plane")
      .argument("<taskId>", "Task ID")
      .requiredOption("--owner-agent-id <id>", "New agent owner ID")
      .option("--idempotency-key <key>", "Retry key (generated when omitted)")
      .action(async (taskId: string, opts: TaskReassignOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = reassignTaskSchema.parse({
            ownerAgentId: opts.ownerAgentId,
            idempotencyKey: opts.idempotencyKey ?? randomUUID(),
          });
          const result = await ctx.api.post(
            apiPath`/api/tasks/${taskId}/reassign`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("comment")
      .description("Add a typed user comment to a task")
      .argument("<taskId>", "Task ID")
      .requiredOption("--message <text>", "Comment message")
      .option("--idempotency-key <key>", "Retry key (generated when omitted)")
      .option("--mention-target-agent-id <id>", "Explicit current owner agent mention")
      .option("--mention-ownership-epoch <n>", "Exact current ownership epoch")
      .option("--reply-to-comment-id <id>", "Persisted comment to reply to")
      .action(async (taskId: string, opts: TaskCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const hasMentionTarget = Boolean(opts.mentionTargetAgentId);
          const hasMentionEpoch = Boolean(opts.mentionOwnershipEpoch);
          if (hasMentionTarget !== hasMentionEpoch) {
            throw new Error(
              "--mention-target-agent-id and --mention-ownership-epoch must be supplied together",
            );
          }
          const payload = createTaskUserCommentSchema.parse({
            message: opts.message,
            idempotencyKey: opts.idempotencyKey ?? randomUUID(),
            mention: hasMentionTarget
              ? {
                  targetAgentId: opts.mentionTargetAgentId,
                  ownershipEpoch: parseRequiredPositiveInt(
                    opts.mentionOwnershipEpoch,
                    "mention ownership epoch",
                  ),
                }
              : null,
            ...(opts.replyToCommentId
              ? { replyToCommentId: opts.replyToCommentId }
              : {}),
          });
          const result = await ctx.api.post(
            apiPath`/api/tasks/${taskId}/comments`,
            payload,
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("comments")
      .description("Page root-grouped task comments")
      .argument("<taskId>", "Task ID")
      .option("--cursor <cursor>", "Opaque root-page cursor")
      .option("--limit <n>", "Maximum root groups to return")
      .option("--entry-limit <n>", "Maximum initial entries per root group")
      .action(async (taskId: string, opts: TaskCommentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.cursor) params.set("cursor", opts.cursor);
          if (opts.limit) params.set("limit", opts.limit);
          if (opts.entryLimit) params.set("entryLimit", opts.entryLimit);
          const query = params.toString();
          const comments = await ctx.api.get<BoardTaskCommentGroupPage>(
            `${apiPath`/api/tasks/${taskId}/comments`}${query ? `?${query}` : ""}`,
          );
          printOutput(comments, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("comment:get")
      .description("Get one task comment")
      .argument("<taskId>", "Task ID")
      .argument("<commentId>", "Comment ID")
      .action(async (taskId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const comment = await ctx.api.get<BoardTaskComment>(apiPath`/api/tasks/${taskId}/comments/${commentId}`);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("approvals")
      .description("List approvals linked to a task")
      .argument("<taskId>", "Task ID")
      .action(async (taskId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const approvals = await ctx.api.get(apiPath`/api/tasks/${taskId}/approvals`);
          printOutput(approvals, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("approval:link")
      .description("Link an approval to a task")
      .argument("<taskId>", "Task ID")
      .argument("<approvalId>", "Approval ID")
      .action(async (taskId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = linkTaskApprovalSchema.parse({ approvalId });
          const approvals = await ctx.api.post(apiPath`/api/tasks/${taskId}/approvals`, payload);
          printOutput(approvals, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("approval:unlink")
      .description("Unlink an approval from a task")
      .argument("<taskId>", "Task ID")
      .argument("<approvalId>", "Approval ID")
      .action(async (taskId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/tasks/${taskId}/approvals/${approvalId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addTaskPostDeleteMarkerCommand(task, "read", "Mark a task as read", "post", "/read");
  addTaskPostDeleteMarkerCommand(task, "unread", "Mark a task as unread", "delete", "/read");
  addTaskPostDeleteMarkerCommand(task, "archive", "Archive a task from the inbox", "post", "/inbox-archive");
  addTaskPostDeleteMarkerCommand(task, "unarchive", "Unarchive a task from the inbox", "delete", "/inbox-archive");

  addCommonClientOptions(
    task
      .command("child:create")
      .description("Create a child task from a JSON payload")
      .argument("<taskId>", "Parent task ID")
      .requiredOption("--payload-json <json>", "CreateChildTask JSON payload")
      .action(async (taskId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createChildTaskSchema.parse(parseJson(opts.payloadJson));
          const child = await ctx.api.post<Task>(apiPath`/api/tasks/${taskId}/children`, payload);
          printOutput(child, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("work-products")
      .description("List task work products")
      .argument("<taskId>", "Task ID")
      .action(async (taskId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await ctx.api.get(apiPath`/api/tasks/${taskId}/work-products`);
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("work-product:create")
      .description("Create a task work product from JSON")
      .argument("<taskId>", "Task ID")
      .requiredOption("--payload-json <json>", "CreateTaskWorkProduct JSON payload")
      .action(async (taskId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createTaskWorkProductSchema.parse(parseJson(opts.payloadJson));
          const product = await ctx.api.post(apiPath`/api/tasks/${taskId}/work-products`, payload);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("work-product:update")
      .description("Update a work product from JSON")
      .argument("<workProductId>", "Work product ID")
      .requiredOption("--payload-json <json>", "UpdateTaskWorkProduct JSON payload")
      .action(async (workProductId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateTaskWorkProductSchema.parse(parseJson(opts.payloadJson));
          const product = await ctx.api.patch(apiPath`/api/work-products/${workProductId}`, payload);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("work-product:delete")
      .description("Delete a work product")
      .argument("<workProductId>", "Work product ID")
      .action(async (workProductId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const product = await ctx.api.delete(apiPath`/api/work-products/${workProductId}`);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("documents")
      .description("List task documents")
      .argument("<taskId>", "Task ID")
      .option("--include-system", "Include system documents")
      .action(async (taskId: string, opts: BaseClientOptions & { includeSystem?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.includeSystem ? "?includeSystem=true" : "";
          const docs = await ctx.api.get(`${apiPath`/api/tasks/${taskId}/documents`}${query}`);
          printOutput(docs, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("document:get")
      .description("Get a task document")
      .argument("<taskId>", "Task ID")
      .argument("<key>", "Document key")
      .action(async (taskId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const doc = await ctx.api.get(apiPath`/api/tasks/${taskId}/documents/${key}`);
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("document:put")
      .description("Create or update a task document")
      .argument("<taskId>", "Task ID")
      .argument("<key>", "Document key")
      .option("--title <title>", "Document title")
      .option("--format <format>", "Document format", "markdown")
      .option("--body <markdown>", "Document body")
      .option("--body-file <path>", "Read document body from a file")
      .option("--change-summary <text>", "Change summary")
      .option("--base-revision-id <id>", "Expected base revision ID")
      .action(async (taskId: string, key: string, opts: TaskDocumentPutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body = opts.bodyFile ? await readFile(opts.bodyFile, "utf8") : opts.body;
          const payload = upsertTaskDocumentSchema.parse({
            title: opts.title,
            format: opts.format,
            body,
            changeSummary: opts.changeSummary,
            baseRevisionId: opts.baseRevisionId,
          });
          const doc = await ctx.api.put(apiPath`/api/tasks/${taskId}/documents/${key}`, payload);
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("tree-state")
      .description("Get task tree control state")
      .argument("<taskId>", "Root task ID")
      .action(async (taskId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const state = await ctx.api.get(apiPath`/api/tasks/${taskId}/tree-control/state`);
          printOutput(state, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("tree-preview")
      .description("Preview task tree control changes")
      .argument("<taskId>", "Root task ID")
      .requiredOption("--payload-json <json>", "PreviewTaskTreeControl JSON payload")
      .action(async (taskId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = previewTaskTreeControlSchema.parse(parseJson(opts.payloadJson));
          const preview = await ctx.api.post(apiPath`/api/tasks/${taskId}/tree-control/preview`, payload);
          printOutput(preview, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("tree-holds")
      .description("List task tree holds")
      .argument("<taskId>", "Root task ID")
      .option("--status <status>", "active or released")
      .option("--mode <mode>", "pause, resume, cancel, or restore")
      .option("--include-members", "Include hold members")
      .action(async (taskId: string, opts: TreeHoldListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.mode) params.set("mode", opts.mode);
          if (opts.includeMembers) params.set("includeMembers", "true");
          const query = params.toString();
          const holds = await ctx.api.get(`${apiPath`/api/tasks/${taskId}/tree-holds`}${query ? `?${query}` : ""}`);
          printOutput(holds, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("tree-hold:create")
      .description("Create a task tree hold from JSON")
      .argument("<taskId>", "Root task ID")
      .requiredOption("--payload-json <json>", "CreateTaskTreeHold JSON payload")
      .action(async (taskId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createTaskTreeHoldSchema.parse(parseJson(opts.payloadJson));
          const hold = await ctx.api.post(apiPath`/api/tasks/${taskId}/tree-holds`, payload);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("tree-hold:get")
      .description("Get a task tree hold")
      .argument("<taskId>", "Root task ID")
      .argument("<holdId>", "Hold ID")
      .action(async (taskId: string, holdId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const hold = await ctx.api.get(apiPath`/api/tasks/${taskId}/tree-holds/${holdId}`);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("tree-hold:release")
      .description("Release a task tree hold")
      .argument("<taskId>", "Root task ID")
      .argument("<holdId>", "Hold ID")
      .option("--payload-json <json>", "ReleaseTaskTreeHold JSON payload", "{}")
      .action(async (taskId: string, holdId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = releaseTaskTreeHoldSchema.parse(parseJson(opts.payloadJson));
          const hold = await ctx.api.post(apiPath`/api/tasks/${taskId}/tree-holds/${holdId}/release`, payload);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("attachments")
      .description("List task attachments")
      .argument("<taskId>", "Task ID")
      .action(async (taskId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const attachments = await ctx.api.get(apiPath`/api/tasks/${taskId}/attachments`);
          printOutput(attachments, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("attachment:upload")
      .description("Upload a task attachment")
      .argument("<taskId>", "Task ID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--file <path>", "File to upload")
      .option("--comment-id <id>", "Attach to a task comment")
      .action(async (taskId: string, opts: TaskAttachmentUploadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const attachment = await uploadAttachment(ctx.api.apiBase, ctx.api.apiKey, {
            companyId: ctx.companyId ?? "",
            taskId,
            filePath: opts.file,
            commentId: opts.commentId,
          });
          printOutput(attachment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    task
      .command("attachment:download")
      .description("Download an attachment")
      .argument("<attachmentId>", "Attachment ID")
      .option("--out <path>", "Output file path; prints to stdout when omitted")
      .action(async (attachmentId: string, opts: TaskAttachmentDownloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const bytes = await downloadAttachment(ctx.api.apiBase, ctx.api.apiKey, attachmentId);
          if (opts.out) {
            await writeFile(opts.out, bytes);
            if (ctx.json) printOutput({ out: opts.out, bytes: bytes.byteLength }, { json: true });
            else console.log(`Wrote ${bytes.byteLength} byte(s) to ${opts.out}`);
            return;
          }
          process.stdout.write(bytes);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("attachment:delete")
      .description("Delete an attachment")
      .argument("<attachmentId>", "Attachment ID")
      .action(async (attachmentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/attachments/${attachmentId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("label:list")
      .description("List task labels in a company")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const labels = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/labels`);
          printOutput(labels, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    task
      .command("label:create")
      .description("Create a task label")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Label name")
      .requiredOption("--color <hex>", "Label color, e.g. #4f46e5")
      .action(async (opts: TaskLabelCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createTaskLabelSchema.parse({ name: opts.name, color: opts.color });
          const label = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/labels`, payload);
          printOutput(label, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    task
      .command("label:delete")
      .description("Delete a task label")
      .argument("<labelId>", "Label ID")
      .action(async (labelId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/labels/${labelId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, pathSuffix, description] of [
    ["document:delete", "", "Delete a task document"],
    ["document:lock", "/lock", "Lock a task document"],
    ["document:unlock", "/unlock", "Unlock a task document"],
  ] as const) {
    addCommonClientOptions(
      task
        .command(name)
        .description(description)
        .argument("<taskId>", "Task ID")
        .argument("<key>", "Document key")
        .action(async (taskId: string, key: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const path = `${apiPath`/api/tasks/${taskId}/documents/${key}`}${pathSuffix}`;
            const result = name === "document:delete" ? await ctx.api.delete(path) : await ctx.api.post(path, {});
            printOutput(result, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    task
      .command("document:revisions")
      .description("List task document revisions")
      .argument("<taskId>", "Task ID")
      .argument("<key>", "Document key")
      .action(async (taskId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const revisions = await ctx.api.get(apiPath`/api/tasks/${taskId}/documents/${key}/revisions`);
          printOutput(revisions, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("document:restore")
      .description("Restore a task document revision")
      .argument("<taskId>", "Task ID")
      .argument("<key>", "Document key")
      .argument("<revisionId>", "Revision ID")
      .action(async (taskId: string, key: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = restoreTaskDocumentRevisionSchema.parse({});
          const doc = await ctx.api.post(
            apiPath`/api/tasks/${taskId}/documents/${key}/revisions/${revisionId}/restore`,
            payload,
          );
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    task
      .command("runs")
      .description("List task-execution runs associated with a task")
      .argument("<taskId>", "Task UUID")
      .action(async (taskId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const page = await ctx.api.get<TaskExecutionRunListPageRecord>(
            apiPath`/api/tasks/${taskId}/runs`,
          );
          printOutput(page ?? { items: [], nextCursor: null }, {
            json: ctx.json,
          });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

}

function addTaskPostDeleteMarkerCommand(
  task: Command,
  name: string,
  description: string,
  method: "post" | "delete",
  pathSuffix: string,
): void {
  addCommonClientOptions(
    task
      .command(name)
      .description(description)
      .argument("<taskId>", "Task ID")
      .action(async (taskId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = method === "post"
            ? await ctx.api.post(`${apiPath`/api/tasks/${taskId}`}${pathSuffix}`, {})
            : await ctx.api.delete(`${apiPath`/api/tasks/${taskId}`}${pathSuffix}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseRequiredPositiveInt(value: string | undefined, label: string): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value ?? ""}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${label}: ${value ?? ""}`);
  }
  return parsed;
}

function filterTaskRows(rows: Task[], match: string | undefined): Task[] {
  if (!match?.trim()) return rows;
  const needle = match.trim().toLowerCase();
  return rows.filter((row) => {
    const text = [row.identifier, row.title, row.request]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .toLowerCase();
    return text.includes(needle);
  });
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

async function uploadAttachment(
  apiBase: string,
  apiKey: string | undefined,
  input: { companyId: string; taskId: string; filePath: string; commentId?: string },
): Promise<unknown> {
  const bytes = await readFile(input.filePath);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: inferContentTypeFromPath(input.filePath) }), input.filePath.split(/[\\/]/).pop() ?? "attachment");
  if (input.commentId) form.set("taskCommentId", input.commentId);
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/companies/${input.companyId}/tasks/${input.taskId}/attachments`), {
    method: "POST",
    headers,
    body: form,
  });
  return parseFetchResponse(response);
}

async function downloadAttachment(
  apiBase: string,
  apiKey: string | undefined,
  attachmentId: string,
): Promise<Buffer> {
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/attachments/${attachmentId}/content`), {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) {
    await parseFetchResponse(response);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function parseFetchResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text.trim() ? safeJson(text) : null;
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `Request failed with status ${response.status}`;
    throw new Error(`API error ${response.status}: ${message}`);
  }
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
