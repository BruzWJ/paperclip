import { createHash } from "node:crypto";
import {
  agentAdapterConfigRevisions,
  companySkills,
  companySkillVersions,
  issueExecutionSessions,
  type Db,
} from "@paperclipai/db";
import {
  selectedCompanySkillMaterializationKey,
  selectedCompanySkillRuntimeName,
  type CollectedSelectedCompanySkillTargetHome,
  type SelectedCompanySkillLaunchChannel,
  type SelectedCompanySkillMaterializationIdentity,
} from "@paperclipai/adapter-utils/selected-company-skills";
import { agentAdapterAcpConfigurationSchema } from "@paperclipai/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  hasActiveIssueExecutionAttemptForMaterializationInTransaction,
} from "./issue-execution-run-service.js";
import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";

type CompanySkillMaterializationTransaction =
  Parameters<Parameters<Db["transaction"]>[0]>[0];

const ELIGIBLE_CORRELATION_STATES = ["eligible", "current"] as const;

export interface CompanySkillMaterializationRevisionScope {
  readonly companyId: string;
  readonly agentId: string;
  readonly adapterConfigRevisionId: string;
}

export type ResolvedCompanySkillMaterializationRevision =
  | {
      readonly channel: "operator_native";
      readonly launchChannel: Extract<
        SelectedCompanySkillLaunchChannel,
        { readonly channel: "operator_native" }
      >;
    }
  | {
      readonly channel: "isolated_skills_home";
      readonly launchChannel: Extract<
        SelectedCompanySkillLaunchChannel,
        { readonly channel: "isolated_skills_home" }
      >;
      readonly materializationKey: string;
      readonly selectedSetDigest: string;
    };

export interface ReapedCompanySkillMaterialization {
  readonly identity: SelectedCompanySkillMaterializationIdentity;
  readonly materializationKey: string;
  collectExact(
    expectedMaterializationKey: string,
  ): Promise<CollectedSelectedCompanySkillTargetHome>;
}

export type CompanySkillMaterializationCollectionDecision =
  | { readonly outcome: "retained_active_attempt"; readonly materializationKey: string }
  | { readonly outcome: "retained_native_correlation"; readonly materializationKey: string }
  | { readonly outcome: "collected" | "absent"; readonly materializationKey: string };

export class CompanySkillMaterializationLifecycleRejected extends Error {
  readonly code = "company_skill_materialization_lifecycle_rejected";

  constructor(message: string) {
    super(message);
    this.name = "CompanySkillMaterializationLifecycleRejected";
  }
}

function reject(message: string): never {
  throw new CompanySkillMaterializationLifecycleRejected(message);
}

function exactIdentifier(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    reject(`${label} must be exact and non-empty`);
  }
  return value;
}

function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) reject(message);
  return rows[0]!;
}

function advisoryLockKey(materializationKey: string): string {
  const digest = createHash("sha256")
    .update("paperclip/company-skill-materialization-fence/v1\0", "utf8")
    .update(materializationKey, "utf8")
    .digest("hex");
  const unsigned = BigInt(`0x${digest.slice(0, 16)}`);
  const signed = unsigned >= (1n << 63n)
    ? unsigned - (1n << 64n)
    : unsigned;
  return signed.toString(10);
}

/**
 * Sole immutable-revision resolver for both ACP launch and the materialization
 * reference fence. operator_native returns before any selected-skill row read.
 */
export async function resolveCompanySkillMaterializationRevisionInTransaction(
  transaction: CompanySkillMaterializationTransaction,
  scope: CompanySkillMaterializationRevisionScope,
): Promise<ResolvedCompanySkillMaterializationRevision> {
  const companyId = exactIdentifier(scope.companyId, "company id");
  const agentId = exactIdentifier(scope.agentId, "agent id");
  const adapterConfigRevisionId = exactIdentifier(
    scope.adapterConfigRevisionId,
    "adapter configuration revision id",
  );
  const revision = exactlyOne(
    await transaction
      .select()
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.id, adapterConfigRevisionId),
          eq(agentAdapterConfigRevisions.companyId, companyId),
          eq(agentAdapterConfigRevisions.agentId, agentId),
        ),
      )
      .limit(2),
    "immutable adapter configuration revision is missing",
  );
  const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
    revision.acpConfiguration,
  );
  if (acpConfiguration.skillChannel === "operator_native") {
    return Object.freeze({
      channel: "operator_native",
      launchChannel: Object.freeze({ channel: "operator_native" }),
    });
  }

  const pins = acpConfiguration.companySkillPins;
  const rows = pins.length === 0
    ? []
    : await transaction
        .select({
          key: companySkills.key,
          slug: companySkills.slug,
          skillId: companySkills.id,
          versionId: companySkillVersions.id,
          versionSkillId: companySkillVersions.companySkillId,
          fileInventory: companySkillVersions.fileInventory,
        })
        .from(companySkills)
        .innerJoin(
          companySkillVersions,
          and(
            eq(companySkillVersions.companyId, companySkills.companyId),
            eq(companySkillVersions.companySkillId, companySkills.id),
          ),
        )
        .where(
          and(
            eq(companySkills.companyId, companyId),
            inArray(companySkills.key, pins.map((pin) => pin.key)),
            inArray(
              companySkillVersions.id,
              pins.map((pin) => pin.versionId),
            ),
          ),
        );
  const rowByPin = new Map(
    rows.map((row) => [`${row.key}\0${row.versionId}`, row] as const),
  );
  if (rowByPin.size !== rows.length) {
    reject("immutable company skill revision pins are ambiguous");
  }
  const entries = pins.map((pin) => {
    const row = rowByPin.get(`${pin.key}\0${pin.versionId}`);
    if (
      !row ||
      row.skillId !== row.versionSkillId ||
      !Array.isArray(row.fileInventory)
    ) {
      reject("immutable company skill revision pin cannot be resolved");
    }
    return Object.freeze({
      key: pin.key,
      runtimeName: selectedCompanySkillRuntimeName(pin.key, row.slug),
      versionId: pin.versionId,
      files: Object.freeze(row.fileInventory.map((file) => Object.freeze({
        path: file.path,
        kind: file.kind,
        content: file.content,
      }))),
    });
  });
  if (entries.length !== rows.length) {
    reject("immutable company skill revision selection has extra rows");
  }
  const identity = Object.freeze({
    companyId,
    agentId,
    executionTargetIdentity:
      localExecutionCorrelationFingerprint(adapterConfigRevisionId),
    adapterConfigRevisionId,
  });
  const key = selectedCompanySkillMaterializationKey({ identity, entries });
  return Object.freeze({
    channel: "isolated_skills_home",
    launchChannel: Object.freeze({
      channel: "isolated_skills_home",
      identity,
      entries: Object.freeze(entries),
    }),
    materializationKey: key.materializationKey,
    selectedSetDigest: key.selectedSetDigest,
  });
}

/**
 * Canonical transaction-scoped cross-owner fence. Every transaction that can
 * add an active attempt or eligible/current native correlation takes this
 * exact complete-key lock before publishing that reference.
 */
export async function fenceCompanySkillMaterializationReferenceInTransaction(
  transaction: CompanySkillMaterializationTransaction,
  scope: CompanySkillMaterializationRevisionScope,
): Promise<ResolvedCompanySkillMaterializationRevision> {
  const resolved =
    await resolveCompanySkillMaterializationRevisionInTransaction(
      transaction,
      scope,
    );
  if (resolved.channel === "isolated_skills_home") {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${advisoryLockKey(resolved.materializationKey)}::bigint)`,
    );
  }
  return resolved;
}

/**
 * Exact-key GC trigger. The transaction advisory fence remains held across
 * the bounded target-side exact-key lock/delete, so no attempt or correlation
 * writer can publish a new reference between the zero-reference decision and
 * collection.
 */
export async function collectCompanySkillMaterializationIfUnreferencedInTransaction(
  transaction: CompanySkillMaterializationTransaction,
  candidate: ReapedCompanySkillMaterialization | null,
): Promise<CompanySkillMaterializationCollectionDecision | null> {
  if (!candidate) return null;
  const resolved =
    await fenceCompanySkillMaterializationReferenceInTransaction(
      transaction,
      candidate.identity,
    );
  if (resolved.channel !== "isolated_skills_home") {
    reject("operator_native produced a Paperclip materialization candidate");
  }
  if (
    resolved.materializationKey !== candidate.materializationKey ||
    resolved.launchChannel.identity.companyId !== candidate.identity.companyId ||
    resolved.launchChannel.identity.agentId !== candidate.identity.agentId ||
    resolved.launchChannel.identity.executionTargetIdentity !==
      candidate.identity.executionTargetIdentity ||
    resolved.launchChannel.identity.adapterConfigRevisionId !==
      candidate.identity.adapterConfigRevisionId
  ) {
    reject("materialization collection candidate crossed its complete revision key");
  }

  if (
    await hasActiveIssueExecutionAttemptForMaterializationInTransaction(
      transaction,
      {
        companyId: candidate.identity.companyId,
        targetAgentId: candidate.identity.agentId,
        adapterConfigRevisionId: candidate.identity.adapterConfigRevisionId,
      },
    )
  ) {
    return Object.freeze({
      outcome: "retained_active_attempt",
      materializationKey: resolved.materializationKey,
    });
  }

  const eligibleCorrelations = await transaction
    .select({ id: issueExecutionSessions.id })
    .from(issueExecutionSessions)
    .where(
      and(
        eq(issueExecutionSessions.companyId, candidate.identity.companyId),
        eq(issueExecutionSessions.targetAgentId, candidate.identity.agentId),
        eq(
          issueExecutionSessions.adapterConfigIdentity,
          candidate.identity.adapterConfigRevisionId,
        ),
        eq(
          issueExecutionSessions.targetFingerprint,
          candidate.identity.executionTargetIdentity,
        ),
        inArray(issueExecutionSessions.state, [
          ...ELIGIBLE_CORRELATION_STATES,
        ]),
      ),
    )
    .limit(1);
  if (eligibleCorrelations.length !== 0) {
    return Object.freeze({
      outcome: "retained_native_correlation",
      materializationKey: resolved.materializationKey,
    });
  }

  const collected = await candidate.collectExact(resolved.materializationKey);
  if (collected.materializationKey !== resolved.materializationKey) {
    reject("target collection returned a different materialization key");
  }
  return Object.freeze({
    outcome: collected.outcome,
    materializationKey: resolved.materializationKey,
  });
}
