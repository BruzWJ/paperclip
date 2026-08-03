import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import {
  budgetCurrencyColumn,
  moneyAmountColumn,
  nonnegativeFiniteMoneyCheck,
  supportedBudgetCurrencyCheck,
} from "./money.js";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetCurrency: budgetCurrencyColumn("budget_currency").notNull(),
    budgetMonthlyAmount: moneyAmountColumn("budget_monthly_amount").notNull(),
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    defaultResponsibleUserId: text("default_responsible_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id").references(
      () => authUsers.id,
      { onDelete: "set null" },
    ),
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    sessionCompaction: jsonb("session_compaction").$type<{
      auto?: boolean;
      prune?: boolean;
      reserved?: number;
      tail_turns?: number;
      preserve_recent_tokens?: number;
      modelRef?: string;
    } | null>(),
    sessionIntegrityState: text("session_integrity_state")
      .$type<
        "ready" | "archive_fenced" | "hard_delete_fenced"
      >()
      .notNull()
      .default("ready"),
    sessionIntegrityReadyAt: timestamp("session_integrity_ready_at", {
      withTimezone: true,
    }).defaultNow(),
    sessionLifecycleGeneration: bigint("session_lifecycle_generation", {
      mode: "number",
    })
      .notNull()
      .default(0),
    hardDeleteFencedAt: timestamp("hard_delete_fenced_at", { withTimezone: true }),
    brandColor: text("brand_color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "companies_budget_currency_check",
      supportedBudgetCurrencyCheck(table.budgetCurrency),
    ),
    check(
      "companies_budget_monthly_amount_check",
      nonnegativeFiniteMoneyCheck(table.budgetMonthlyAmount),
    ),
    check(
      "companies_session_integrity_state_check",
      sql`${table.sessionIntegrityState} in (
        'ready',
        'archive_fenced',
        'hard_delete_fenced'
      )`,
    ),
    check(
      "companies_session_integrity_ready_check",
      sql`(
        ${table.sessionIntegrityState} = 'ready'
        and ${table.sessionIntegrityReadyAt} is not null
      ) or (
        ${table.sessionIntegrityState} <> 'ready'
      )`,
    ),
    check(
      "companies_session_compaction_check",
      sql`${table.sessionCompaction} is null
        or (
          jsonb_typeof(${table.sessionCompaction}) = 'object'
          and ${table.sessionCompaction}
            - 'auto'
            - 'prune'
            - 'reserved'
            - 'tail_turns'
            - 'preserve_recent_tokens'
            - 'modelRef' = '{}'::jsonb
          and (
            not (${table.sessionCompaction} ? 'auto')
            or jsonb_typeof(${table.sessionCompaction} -> 'auto') = 'boolean'
          )
          and (
            not (${table.sessionCompaction} ? 'prune')
            or jsonb_typeof(${table.sessionCompaction} -> 'prune') = 'boolean'
          )
          and (
            not (${table.sessionCompaction} ? 'reserved')
            or (
              jsonb_typeof(${table.sessionCompaction} -> 'reserved') = 'number'
              and (${table.sessionCompaction} ->> 'reserved') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not (${table.sessionCompaction} ? 'tail_turns')
            or (
              jsonb_typeof(${table.sessionCompaction} -> 'tail_turns') = 'number'
              and (${table.sessionCompaction} ->> 'tail_turns') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not (${table.sessionCompaction} ? 'preserve_recent_tokens')
            or (
              jsonb_typeof(${table.sessionCompaction} -> 'preserve_recent_tokens') = 'number'
              and (${table.sessionCompaction} ->> 'preserve_recent_tokens') ~ '^(0|[1-9][0-9]*)$'
            )
          )
          and (
            not (${table.sessionCompaction} ? 'modelRef')
            or (
              jsonb_typeof(${table.sessionCompaction} -> 'modelRef') = 'string'
              and btrim(${table.sessionCompaction} ->> 'modelRef') <> ''
              and length(btrim(${table.sessionCompaction} ->> 'modelRef')) <= 500
            )
          )
        )`,
    ),
    uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
    unique("companies_id_budget_currency_uq").on(
      table.id,
      table.budgetCurrency,
    ),
    index("companies_session_integrity_idx").on(
      table.sessionIntegrityState,
      table.updatedAt,
    ),
  ],
);
