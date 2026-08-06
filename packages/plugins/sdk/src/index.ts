/**
 * `@paperclipai/plugin-sdk` — Paperclip plugin worker-side SDK.
 *
 * This is the main entrypoint for plugin worker code.  For plugin UI bundles,
 * import from `@paperclipai/plugin-sdk/ui` instead.
 *
 * @example
 * ```ts
 * // Plugin worker entrypoint (dist/worker.ts)
 * import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
 *
 * const plugin = definePlugin({
 *   async setup(ctx) {
 *     await ctx.logger.info("Plugin starting up");
 *
 *     ctx.events.on("issue.board.comment.created", async (event) => {
 *       await ctx.logger.info("Issue created", { issueId: event.entityId });
 *     });
 *
 *     ctx.jobs.register("full-sync", async (job) => {
 *       await ctx.logger.info("Starting full sync", { runId: job.runId });
 *       // ... sync implementation
 *     });
 *
 *     ctx.data.register("sync-health", async ({ companyId }) => {
 *       const state = await ctx.state.get({
 *         scopeKind: "company",
 *         scopeId: String(companyId),
 *         stateKey: "last-sync-at",
 *       });
 *       return { lastSync: state };
 *     });
 *   },
 *
 *   async onHealth() {
 *     return { status: "ok" };
 *   },
 * });
 *
 * export default plugin;
 * runWorker(plugin, import.meta.url);
 * ```
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export { definePlugin } from "./define-plugin.js";
export { runWorker } from "./worker-rpc-host.js";
export { decodeToolResult } from "./tool-result.js";
export {
  assertPluginEventSubscription,
  pluginEventMatchesFilter,
} from "./event-filter.js";
export { normalizePluginScopeId } from "./plugin-scope.js";
export { createHostClientHandlers } from "./host-client-factory.js";

// JSON-RPC protocol helpers and constants
export {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  HOST_TO_WORKER_REQUIRED_METHODS,
  HOST_TO_WORKER_OPTIONAL_METHODS,
  createRequest,
  createErrorResponse,
  isJsonRpcResponse,
  isJsonRpcSuccessResponse,
  serializeMessage,
  parseMessage,
  JsonRpcCallError,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

// Plugin definition and lifecycle types
export type {
  PluginDefinition,
  PaperclipPlugin,
  PluginHealthDiagnostics,
  PluginConfigValidationResult,
  PluginWebhookInput,
  PluginApiRequestInput,
  PluginApiResponse,
} from "./define-plugin.js";
export type {
  HostServices,
  HostClientHandlers,
} from "./host-client-factory.js";

// JSON-RPC protocol types
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcMessage,
  JsonRpcErrorCode,
  PluginRpcErrorCode,
  PluginInvocationScope,
  PluginInvocationContext,
  WorkerHostCallContext,
  InitializeParams,
  InitializeResult,
  ValidateConfigParams,
  OnEventParams,
  RunJobParams,
  GetDataParams,
  PerformActionParams,
  PluginPerformActionActorType,
  PluginPerformActionActorContext,
  PluginPerformActionContext,
  ExecuteToolParams,
  PluginExternalObjectUrlCandidate,
  PluginExternalObjectSourceContext,
  DetectExternalObjectsParams,
  PluginExternalObjectDetection,
  DetectExternalObjectsResult,
  PluginExternalObjectRecordSnapshot,
  ResolveExternalObjectParams,
  PluginExternalObjectResolvedSnapshot,
  PluginExternalObjectResolveResult,
  PluginEnvironmentDiagnostic,
  PluginEnvironmentDriverBaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentLease,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentCancelExecutionParams,
  PluginEnvironmentCancelExecutionResult,
  PluginSyncFileMapping,
  PluginSyncOperation,
  PluginEnvironmentSyncParams,
  PluginEnvironmentSyncResult,
  PluginEnvironmentInteractiveSetupStatus,
  PluginEnvironmentInteractiveSetupConnectionType,
  PluginEnvironmentTemplateRefKind,
  PluginEnvironmentInteractiveSetupConnectionSummary,
  PluginEnvironmentInteractiveSetupConnectionPayload,
  PluginEnvironmentInteractiveSetupSession,
  PluginEnvironmentStartInteractiveSetupParams,
  PluginEnvironmentGetInteractiveSetupParams,
  PluginEnvironmentCaptureTemplateParams,
  PluginEnvironmentCaptureTemplateResult,
  PluginEnvironmentCancelInteractiveSetupParams,
  PluginEnvironmentCancelInteractiveSetupResult,
  PluginEnvironmentDeleteTemplateParams,
  PluginEnvironmentDeleteTemplateResult,
  PluginModalBoundsRequest,
  PluginRenderCloseEvent,
  PluginLauncherRenderContextSnapshot,
  HostToWorkerMethods,
  HostToWorkerMethodName,
  HostToWorkerRequiredMethodName,
  HostToWorkerOptionalMethodName,
  WorkerToHostMethods,
  WorkerToHostMethodName,
} from "./protocol.js";

// Plugin context and all client interfaces
export type {
  PluginContext,
  PluginConfigClient,
  PluginLocalFolderProblem,
  PluginLocalFolderStatus,
  PluginLocalFolderConfigureInput,
  PluginLocalFolderListOptions,
  PluginLocalFolderEntry,
  PluginLocalFolderListing,
  PluginLocalFoldersClient,
  PluginEventsClient,
  PluginJobsClient,
  PluginHttpClient,
  PluginActivityClient,
  PluginActivityLogEntry,
  PluginStateClient,
  PluginEntitiesClient,
  PluginProjectsClient,
  PluginExecutionWorkspacesClient,
  PluginRoutinesClient,
  PluginSkillsClient,
  PluginCompaniesClient,
  PluginIssuesClient,
  PluginContextAccess,
  PluginIssueCreateInput,
  PluginIssueUpdateInput,
  PluginIssueWithdrawalResult,
  PluginCreatorCallbackRegistration,
  PluginCreatorCallbackDelivery,
  PluginCreatorCallbackAcknowledgement,
  PluginCreatorCallbackHandler,
  PluginAgentsClient,
  PluginAccessClient,
  PluginAccessMembersClient,
  PluginAccessInvitesClient,
  PluginAccessMember,
  PluginAccessInvite,
  PluginAuthorizationClient,
  PluginAuthorizationPolicySummary,
  PluginAuthorizationPolicyRecord,
  PluginAssignmentPreviewInput,
  PluginAuthorizationDecisionResult,
  PluginAuthorizationAuditEntry,
  PluginGoalsClient,
  PluginDataClient,
  PluginActionsClient,
  PluginToolsClient,
  PluginMetricsClient,
  PluginTelemetryClient,
  PluginLogger,
} from "./types.js";

// Supporting types for context clients
export type {
  ScopeKey,
  PluginDataScope,
  EventFilter,
  PluginEventPattern,
  PluginEvent,
  PluginJobContext,
  PluginBeforePromptInput,
  PluginBeforePromptResult,
  PluginRunContextHandle,
  PluginRunIssueProjection,
  PluginRunIssueCommentProjection,
  ProviderSafeRunTrace,
  PluginRunPage,
  PluginRunIssuesClient,
  PluginToolRunContext,
  PluginResolvedRunContext,
  PluginRunIssueReach,
  PluginRuntimeClient,
  PluginRuntimeRecordsClient,
  PluginJsonValue,
  PluginToolStructuredData,
  PluginCanonicalSessionIdentity,
  PluginCanonicalSessionMessageRow,
  PluginCanonicalSessionMessage,
  PluginCanonicalSessionEventRow,
  PluginCanonicalSessionEvent,
  PluginCanonicalSessionReadInput,
  PluginCanonicalSessionReadResult,
  ToolResult,
  PluginEntityUpsert,
  PluginEntityRecord,
  PluginEntityQuery,
  PluginWorkspace,
  PluginExecutionWorkspaceMetadata,
  Company,
  Project,
  Issue,
  IssueComment,
  IssueDocumentSummary,
  Agent,
  Goal,
  PermissionKey,
  PrincipalPermissionGrant,
  PrincipalType,
  PluginDatabaseClient,
  HumanCompanyMembershipRole,
  MembershipStatus,
  IssueExecutionSessionOperation,
} from "./types.js";

// Manifest and constant types re-exported from @paperclipai/shared
// Plugin authors import manifest types from here so they have a single
// dependency (@paperclipai/plugin-sdk) for all plugin authoring needs.
export type {
  PaperclipPluginManifestV1,
  PluginJobDeclaration,
  PluginWebhookDeclaration,
  PluginToolDeclaration,
  PluginEnvironmentDriverDeclaration,
  PluginEnvironmentTemplateConfigBinding,
  PluginManagedAgentDeclaration,
  PluginManagedAgentResolution,
  PluginManagedProjectDeclaration,
  PluginManagedProjectResolution,
  PluginManagedRoutineDeclaration,
  PluginManagedRoutineResolution,
  PluginManagedSkillDeclaration,
  PluginManagedSkillFileDeclaration,
  PluginManagedSkillResolution,
  CompanySkill,
  PluginManagedResourceKind,
  PluginManagedResourceRef,
  PluginUiSlotDeclaration,
  PluginUiDeclaration,
  PluginLauncherActionDeclaration,
  PluginLauncherRenderDeclaration,
  PluginLauncherDeclaration,
  PluginDatabaseDeclaration,
  PluginApiRouteCompanyResolution,
  PluginApiRouteDeclaration,
  PluginLocalFolderDeclaration,
  PluginObjectReferenceRefreshPolicy,
  PluginObjectReferenceProviderDeclaration,
  JsonSchema,
  PluginCategory,
  PluginCapability,
  PluginUiSlotType,
  PluginUiSlotEntityType,
  PluginLauncherPlacementZone,
  PluginLauncherAction,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
  PluginStateScopeKind,
  PluginJobRunTrigger,
  PluginDatabaseCoreReadTable,
  PluginApiRouteMethod,
  PluginEventType,
  PluginBridgeErrorCode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants re-exports (for plugin code that needs to check values at runtime)
// ---------------------------------------------------------------------------

export {
  pluginManifestV1Schema,
  PLUGIN_API_VERSION,
  PLUGIN_CATEGORIES,
  PLUGIN_CAPABILITIES,
  PLUGIN_UI_SLOT_TYPES,
  PLUGIN_UI_SLOT_ENTITY_TYPES,
  PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS,
  PLUGIN_STATE_SCOPE_KINDS,
  PLUGIN_JOB_RUN_TRIGGERS,
  PLUGIN_EVENT_TYPES,
  PLUGIN_BRIDGE_ERROR_CODES,
  pluginAgentToolName,
  PERMISSION_KEYS,
  HUMAN_COMPANY_MEMBERSHIP_ROLES,
  HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS,
  MEMBERSHIP_STATUSES,
  PRINCIPAL_TYPES,
} from "@paperclipai/shared";
