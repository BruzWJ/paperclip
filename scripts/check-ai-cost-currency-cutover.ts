import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const GATE_PATH = "scripts/check-ai-cost-currency-cutover.ts";
const SELF_TEST_PATH = "scripts/check-ai-cost-currency-cutover.test.ts";
const BUDGET_OWNER = "apps/server/src/services/budgets.ts";
const COMPANY_PURGE_OWNER =
  "apps/server/src/services/task-session-lifecycle.ts";

const RETIRED_AI_MONEY_TOKENS = [
  "budgetMonthlyCents",
  "spentMonthlyCents",
  "costCents",
  "amountCents",
  "limitCents",
  "billed_cents",
  "costUsd",
  "formatCents",
] as const;

const CANONICAL_SCAN_ROOTS = [
  "packages/db",
  "packages/shared/src",
  "packages/adapter-utils/src",
  "apps/server/src",
  "packages/cli/src",
  "apps/ui/src",
  "apps/docs/api",
  "apps/docs/cli",
  "apps/docs/companies",
  "apps/docs/guides",
] as const;

const FINANCE_EVENT_PRODUCTION_OWNERS = new Set([
  "packages/db/schema/finance_events.ts",
  "packages/db/schema/index.ts",
  "apps/server/src/services/finance.ts",
  COMPANY_PURGE_OWNER,
]);

const AI_MONEY_PRESENTATION_PATHS = [
  "packages/cli/src/commands/client/cost.ts",
  "apps/ui/src/routes/_authenticated/$companyId/-approval-presentation/-ApprovalPayload.tsx",
  "apps/ui/src/routes/_authenticated/$companyId/costs/-BudgetIncidentCard.tsx",
  "apps/ui/src/routes/_authenticated/$companyId/-BudgetPolicyCard.tsx",
  "apps/ui/src/lib/utils.ts",
  "apps/ui/src/routes/_authenticated/$companyId/agents/$agentId/index.tsx",
  "apps/ui/src/routes/_authenticated/$companyId/companies/index.tsx",
  "apps/ui/src/routes/_authenticated/$companyId/costs/index.tsx",
  "apps/ui/src/routes/_authenticated/$companyId/dashboard/index.tsx",
  "apps/ui/src/routes/_authenticated/$companyId/projects/$projectId/index.tsx",
  "apps/ui/src/routes/_authenticated/$companyId/u/$userId/index.tsx",
] as const;

const SUBORDINATE_BUDGET_SCHEMA_PATHS = [
  "packages/db/schema/agents.ts",
  "packages/db/schema/projects.ts",
  "packages/db/schema/budget_policies.ts",
  "packages/db/schema/budget_incidents.ts",
  "packages/db/schema/agent_runtime_state.ts",
] as const;

const SUBORDINATE_BUDGET_VALIDATOR_PATHS = [
  "packages/shared/src/validators/agent.ts",
  "packages/shared/src/validators/project.ts",
  "packages/shared/src/validators/runtime-agent-configuration.ts",
] as const;

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function isTestPath(path: string): boolean {
  return (
    path.includes("/__tests__/") ||
    /(?:^|\/)__fixtures__(?:\/|$)/.test(path) ||
    /\.(?:test|spec)\.[^.]+$/.test(path)
  );
}

function productionFiles(
  repositoryRoot: string,
  roots: readonly string[],
): Array<{ path: string; source: string }> {
  return listRepositoryTextFiles(repositoryRoot, roots)
    .map((absolute) => ({
      path: normalizePath(relative(repositoryRoot, absolute)),
      source: readFileSync(absolute, "utf8"),
    }))
    .filter((file) => !isTestPath(file.path));
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function scanStandaloneActiveDoc(
  repositoryRoot: string,
  path: string,
): string[] {
  const source = read(repositoryRoot, path);
  if (source === null) return [`${path}: required active contract is missing`];
  const violations: string[] = [];
  for (const token of RETIRED_AI_MONEY_TOKENS) {
    let offset = source.indexOf(token);
    while (offset !== -1) {
      violations.push(
        `${path}:${lineAt(source, offset)}: forbidden retired token ${token}`,
      );
      offset = source.indexOf(token, offset + token.length);
    }
  }
  return violations;
}

function tableAliases(source: string, canonical: string): Set<string> {
  const aliases = new Set([canonical]);
  for (const match of source.matchAll(
    new RegExp(`\\b${canonical}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g"),
  )) {
    aliases.add(match[1]!);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of [...aliases]) {
      for (const match of source.matchAll(
        new RegExp(
          `\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${alias}\\b`,
          "g",
        ),
      )) {
        if (!aliases.has(match[1]!)) {
          aliases.add(match[1]!);
          changed = true;
        }
      }
    }
  }
  return aliases;
}

function budgetWriterViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const file of productionFiles(repositoryRoot, ["apps/server/src"])) {
    for (const table of ["budgetPolicies", "budgetIncidents"] as const) {
      for (const alias of tableAliases(file.source, table)) {
        const mutation = new RegExp(
          `\\.(insert|update|delete)\\(\\s*(?:[A-Za-z_$][\\w$]*\\.)?${alias}\\s*\\)`,
          "g",
        );
        for (const match of file.source.matchAll(mutation)) {
          const operation = match[1]!;
          const allowed =
            file.path === BUDGET_OWNER ||
            (file.path === COMPANY_PURGE_OWNER && operation === "delete");
          if (!allowed) {
            violations.push(
              `${file.path}:${lineAt(file.source, match.index!)}: ${operation}s ${table} outside ${BUDGET_OWNER}`,
            );
          }
        }
      }
    }

    for (const match of file.source.matchAll(
      /\b(insert\s+into|update|delete\s+from)\s+(budget_policies|budget_incidents)\b/gi,
    )) {
      const operation = match[1]!.toLowerCase();
      const allowed =
        file.path === BUDGET_OWNER ||
        (file.path === COMPANY_PURGE_OWNER && operation.startsWith("delete"));
      if (!allowed) {
        violations.push(
          `${file.path}:${lineAt(file.source, match.index!)}: raw budget-table mutation outside ${BUDGET_OWNER}`,
        );
      }
    }

    for (const table of ["companies", "agents"] as const) {
      for (const alias of tableAliases(file.source, table)) {
        const mutation = new RegExp(
          `\\.(?:insert|update)\\(\\s*(?:[A-Za-z_$][\\w$]*\\.)?${alias}\\s*\\)\\s*\\.(?:values|set)\\(\\s*\\{[^}]{0,1200}?(?:budgetMonthlyAmount|knownSpendAmount)\\s*:`,
          "g",
        );
        for (const match of file.source.matchAll(mutation)) {
          if (file.path !== BUDGET_OWNER) {
            violations.push(
              `${file.path}:${lineAt(file.source, match.index!)}: writes a retained monthly-limit projection outside ${BUDGET_OWNER}`,
            );
          }
        }
      }
    }

    for (const alias of tableAliases(file.source, "companies")) {
      const mutation = new RegExp(
        `\\.update\\(\\s*(?:[A-Za-z_$][\\w$]*\\.)?${alias}\\s*\\)\\s*\\.set\\(\\s*\\{[^}]{0,1200}?budgetCurrency\\s*:`,
        "g",
      );
      for (const match of file.source.matchAll(mutation)) {
        violations.push(
          `${file.path}:${lineAt(file.source, match.index!)}: mutates immutable company budget currency`,
        );
      }
    }

    for (const match of file.source.matchAll(
      /\bupdate\s+companies\b[\s\S]{0,1200}?\bbudget_currency\b/gi,
    )) {
      violations.push(
        `${file.path}:${lineAt(file.source, match.index!)}: raw SQL mutates immutable company budget currency`,
      );
    }

    for (const match of file.source.matchAll(
      /\b(?:insert\s+into|update)\s+(companies|agents)\b[\s\S]{0,1200}?\b(?:budget_monthly_amount|known_spend_amount|spent_monthly_amount)\b/gi,
    )) {
      if (file.path !== BUDGET_OWNER) {
        violations.push(
          `${file.path}:${lineAt(file.source, match.index!)}: raw SQL writes a budget/spend projection outside ${BUDGET_OWNER}`,
        );
      }
    }
  }
  return violations;
}

function storageAndDtoOwnershipViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const path of SUBORDINATE_BUDGET_SCHEMA_PATHS) {
    const source = read(repositoryRoot, path);
    if (source === null) {
      violations.push(`${path}: required canonical schema owner is missing`);
      continue;
    }
    for (const match of source.matchAll(
      /\bbudgetCurrency\s*:|["']budget_currency["']|\bcurrency\s*:\s*(?:budgetCurrencyColumn|text)\s*\(/g,
    )) {
      violations.push(
        `${path}:${lineAt(source, match.index!)}: subordinate budget row owns a second currency`,
      );
    }
    for (const match of source.matchAll(
      /\b(?:knownSpendAmount|spentMonthlyAmount)\s*:|["'](?:known_spend_amount|spent_monthly_amount)["']/g,
    )) {
      violations.push(
        `${path}:${lineAt(source, match.index!)}: derived spend is persisted as a writable projection`,
      );
    }
    if (path.endsWith("/projects.ts")) {
      for (const match of source.matchAll(
        /\bbudgetMonthlyAmount\s*:|["']budget_monthly_amount["']/g,
      )) {
        violations.push(
          `${path}:${lineAt(source, match.index!)}: project limit bypasses the canonical budget policy owner`,
        );
      }
    }
  }

  for (const path of SUBORDINATE_BUDGET_VALIDATOR_PATHS) {
    const source = read(repositoryRoot, path);
    if (source === null) {
      violations.push(`${path}: required canonical validator owner is missing`);
      continue;
    }
    for (const match of source.matchAll(
      /\bbudgetCurrency\s*:|\bcurrency\s*:\s*budgetCurrencySchema\b/g,
    )) {
      violations.push(
        `${path}:${lineAt(source, match.index!)}: agent/project input can supply a second budget currency`,
      );
    }
  }

  const companySchema = read(repositoryRoot, "packages/db/schema/companies.ts");
  if (
    companySchema !== null &&
    /budgetCurrency\s*:\s*budgetCurrencyColumn\([^)]*\)\s*\.notNull\(\)\s*\.default\s*\(/s.test(
      companySchema,
    )
  ) {
    violations.push(
      "packages/db/schema/companies.ts: company budget currency defaults in PostgreSQL instead of only at canonical creation",
    );
  }

  for (const file of productionFiles(repositoryRoot, [
    "packages/shared/src/types",
    "packages/shared/src/validators",
    "apps/server/src/routes",
    "packages/cli/src",
    "apps/ui/src",
  ])) {
    for (const match of file.source.matchAll(
      /\b[A-Za-z_$][\w$]*Cents\b|\b[a-z][a-z0-9_]*_cents\b/g,
    )) {
      violations.push(
        `${file.path}:${lineAt(file.source, match.index!)}: cents-only AI money status or DTO survives`,
      );
    }
  }
  return violations;
}

function sharedMoneyContractViolations(repositoryRoot: string): string[] {
  const path = "packages/shared/src/money.ts";
  const source = read(repositoryRoot, path);
  if (source === null)
    return [`${path}: required canonical money owner is missing`];

  const violations: string[] = [];
  const catalog = source.match(
    /export const BUDGET_CURRENCIES\s*=\s*\[([\s\S]*?)\]\s*as const/,
  )?.[1];
  if (catalog === undefined) {
    violations.push(
      `${path}: exact budget currency catalog is not statically closed`,
    );
  } else {
    const currencies = [...catalog.matchAll(/["']([^"']+)["']/g)].map(
      (match) => match[1]!,
    );
    if (currencies.length === 0) {
      violations.push(`${path}: exact budget currency catalog is empty`);
    }
    for (const currency of currencies) {
      if (!/^[A-Z]{3}$/.test(currency)) {
        violations.push(
          `${path}: budget currency catalog contains non-uppercase ISO-shaped value ${currency}`,
        );
      }
    }
    if (new Set(currencies).size !== currencies.length) {
      violations.push(`${path}: budget currency catalog contains duplicates`);
    }
  }

  const parseCurrencyBlock = source.match(
    /export function parseBudgetCurrency\b[\s\S]*?^}/m,
  )?.[0];
  if (parseCurrencyBlock === undefined) {
    violations.push(`${path}: exact budget currency parser is missing`);
  } else {
    if (
      /\.trim\s*\(|\.toUpperCase\s*\(|\.toLowerCase\s*\(|\.normalize\s*\(|\bString\s*\(|\?\?|\|\|/.test(
        parseCurrencyBlock,
      )
    ) {
      violations.push(
        `${path}: budget currency parser normalizes, coerces, aliases, or defaults input`,
      );
    }
    if (
      !parseCurrencyBlock.includes("isBudgetCurrency(value)") ||
      !parseCurrencyBlock.includes("return value;")
    ) {
      violations.push(
        `${path}: budget currency parser does not preserve exact accepted bytes`,
      );
    }
  }
  return violations;
}

function rawCostAggregateViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const file of productionFiles(repositoryRoot, ["apps/server/src"])) {
    for (const match of file.source.matchAll(
      /sum\(\s*\$\{costEvents\.([A-Za-z_$][\w$]*)\}\s*\)/g,
    )) {
      if (match[1] !== "knownDeltaAmount") {
        violations.push(
          `${file.path}:${lineAt(file.source, match.index!)}: aggregates costEvents.${match[1]} instead of knownDeltaAmount`,
        );
        continue;
      }
      const nearby = file.source.slice(
        Math.max(0, match.index! - 1800),
        Math.min(file.source.length, match.index! + match[0].length + 1800),
      );
      if (
        !/(?:costEvents\.kind[^\n]{0,160}["']known["']|["']known["'][^\n]{0,160}costEvents\.kind)/.test(
          nearby,
        )
      ) {
        violations.push(
          `${file.path}:${lineAt(file.source, match.index!)}: knownDeltaAmount aggregation is not fenced to known cost events`,
        );
      }
    }
    for (const match of file.source.matchAll(
      /sum\(\s*cost_events\.([A-Za-z_$][\w$]*)\s*\)/gi,
    )) {
      if (match[1] !== "known_delta_amount") {
        violations.push(
          `${file.path}:${lineAt(file.source, match.index!)}: raw SQL aggregates a noncanonical cost column`,
        );
      }
    }
  }
  return violations;
}

function numberMoneyBoundaryViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  const moneyField =
    "budgetMonthlyAmount|limitAmount|observedAmount|knownSpendAmount|knownCostAmount|remainingAmount|knownDeltaAmount";
  for (const file of productionFiles(repositoryRoot, [
    "packages/shared/src",
    "apps/server/src",
    "packages/cli/src",
    "apps/ui/src",
  ])) {
    for (const pattern of [
      new RegExp(`\\b(?:${moneyField})\\??\\s*:\\s*number\\b`, "g"),
      new RegExp(
        `["']?(?:${moneyField})["']?\\s*:\\s*-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?`,
        "gi",
      ),
      new RegExp(`\\b(?:${moneyField})\\s*:\\s*z\\.number\\(`, "g"),
    ]) {
      for (const match of file.source.matchAll(pattern)) {
        violations.push(
          `${file.path}:${lineAt(file.source, match.index!)}: money crosses a JavaScript-number boundary`,
        );
      }
    }
  }
  return violations;
}

function genericPatchViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const file of productionFiles(repositoryRoot, [
    "apps/server/src/routes",
    "packages/shared/src/validators",
  ])) {
    for (const match of file.source.matchAll(
      /router\.patch\(\s*["'`]([^"'`]+)["'`]/g,
    )) {
      const route = match[1]!;
      if (
        route.includes("/budgets") ||
        route.includes("/operational-configuration")
      ) {
        continue;
      }
      const body = file.source.slice(
        match.index!,
        Math.min(file.source.length, match.index! + 2600),
      );
      if (/budgetMonthlyAmount|knownSpendAmount/.test(body)) {
        violations.push(
          `${file.path}:${lineAt(file.source, match.index!)}: generic PATCH can mutate a budget or derived spend field`,
        );
      }
    }
  }

  const companyValidator = read(
    repositoryRoot,
    "packages/shared/src/validators/company.ts",
  );
  const updateCompanyBlock = companyValidator?.match(
    /export const updateCompanySchema[\s\S]*?export type UpdateCompany/,
  )?.[0];
  if (
    !updateCompanyBlock ||
    /budgetCurrency|budgetMonthlyAmount|knownSpendAmount/.test(
      updateCompanyBlock,
    )
  ) {
    violations.push(
      "packages/shared/src/validators/company.ts: generic company update admits budget, currency, or spend",
    );
  }
  return violations;
}

function financeIsolationViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const file of productionFiles(repositoryRoot, [
    "packages/db",
    "packages/shared/src",
    "packages/adapter-utils/src",
    "apps/server/src",
  ])) {
    if (
      /\bfinanceEvents\b|schema\/finance_events|from\s+["'][^"']*finance_events/.test(
        file.source,
      ) &&
      !FINANCE_EVENT_PRODUCTION_OWNERS.has(file.path)
    ) {
      violations.push(
        `${file.path}: finance_events escapes its isolated finance/purge graph`,
      );
    }
  }
  const financeService = read(
    repositoryRoot,
    "apps/server/src/services/finance.ts",
  );
  if (
    financeService === null ||
    /\bcostEvents\b|budgetService|budgetCurrency/.test(financeService)
  ) {
    violations.push(
      "apps/server/src/services/finance.ts: finance aggregation depends on AI cost or budget currency",
    );
  }
  for (const path of [
    BUDGET_OWNER,
    "apps/server/src/services/costs.ts",
    "apps/server/src/services/acp-prompt-settlement.ts",
    "packages/shared/src/acp-cost.ts",
  ]) {
    const source = read(repositoryRoot, path);
    if (source !== null && /\bfinanceEvents\b|finance_events/.test(source)) {
      violations.push(`${path}: AI accounting queries the finance ledger`);
    }
  }
  return violations;
}

function hardCodedPresentationViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const path of AI_MONEY_PRESENTATION_PATHS) {
    const source = read(repositoryRoot, path);
    if (source === null) {
      violations.push(`${path}: required money presentation owner is missing`);
      continue;
    }
    for (const match of source.matchAll(
      /formatCents|(?:^|[^A-Za-z0-9_$])\$\d|["']\$["']|>\$|\$\$\{/gm,
    )) {
      violations.push(
        `${path}:${lineAt(source, match.index!)}: hard-coded AI money presentation`,
      );
    }
  }
  return violations;
}

function canonicalOwnershipViolations(repositoryRoot: string): string[] {
  return [
    ...requireFileTokens(repositoryRoot, "packages/shared/src/money.ts", [
      "export const BUDGET_CURRENCIES",
      "export type BudgetCurrency",
      "export function parseBudgetCurrency",
      "export type MoneyAmount",
      "export function parseMoneyAmount",
      "export function canonicalizeMoneyAmount",
      "export function compareMoneyAmounts",
      "export function addMoneyAmounts",
      "export function serializeMoneyAmount",
      "export const budgetCurrencySchema",
      "export const moneyAmountSchema",
      "z.enum(BUDGET_CURRENCIES)",
      "BUDGET_CURRENCY_OPENAPI_SCHEMA",
      "MONEY_AMOUNT_OPENAPI_SCHEMA",
    ]),
    ...requireFileTokens(repositoryRoot, "packages/shared/src/index.ts", [
      "type BudgetCurrency",
      "type MoneyAmount",
      "parseBudgetCurrency",
      "parseMoneyAmount",
      "moneyAmountSchema",
    ]),
    ...requireFileTokens(repositoryRoot, "packages/db/schema/money.ts", [
      'numeric(name, { mode: "string" })',
      ".$type<MoneyAmount>()",
      ".$type<BudgetCurrency>()",
      "nonnegativeFiniteMoneyCheck",
      "supportedBudgetCurrencyCheck",
    ]),
    ...requireFileTokens(repositoryRoot, "packages/db/schema/companies.ts", [
      'budgetCurrency: budgetCurrencyColumn("budget_currency").notNull()',
      'budgetMonthlyAmount: moneyAmountColumn("budget_monthly_amount").notNull()',
      '"companies_budget_currency_check"',
      'unique("companies_id_budget_currency_uq")',
    ]),
    ...requireFileTokens(repositoryRoot, "packages/db/schema/agents.ts", [
      'budgetMonthlyAmount: moneyAmountColumn("budget_monthly_amount").notNull()',
      '"agents_budget_monthly_amount_check"',
    ]),
    ...requireFileTokens(
      repositoryRoot,
      "packages/db/schema/budget_policies.ts",
      [
        'limitAmount: moneyAmountColumn("limit_amount").notNull()',
        '"budget_policies_limit_amount_check"',
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/db/schema/budget_incidents.ts",
      [
        'limitAmount: moneyAmountColumn("limit_amount").notNull()',
        'observedAmount: moneyAmountColumn("observed_amount").notNull()',
        '"budget_incidents_amounts_check"',
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/db/schema/agent_runtime_state.ts",
      [
        "aggregateKnownCostAmount: moneyAmountColumn(",
        '"aggregate_known_cost_amount"',
        '"agent_runtime_state_aggregates_check"',
      ],
    ),
    ...requireFileTokens(repositoryRoot, "packages/db/schema/cost_events.ts", [
      'knownDeltaAmount: moneyAmountColumn("known_delta_amount")',
      'name: "cost_events_company_budget_currency_fk"',
      '"cost_events_transition_check"',
      "table.observedCurrency} = ${table.budgetCurrency}",
    ]),
    ...requireFileTokens(
      repositoryRoot,
      "packages/db/schema/finance_events.ts",
      [
        'amount: moneyAmountColumn("amount").notNull()',
        'currency: text("currency").notNull()',
      ],
    ),
    ...requireFileTokens(repositoryRoot, BUDGET_OWNER, [
      "async function upsertPolicyInTransaction",
      "companyCurrency(",
      'parseBudgetCurrency(data.budgetCurrency ?? "USD")',
      "resolveScopeRecord(",
      '.for("update")',
      ".update(budgetPolicies)",
      ".insert(budgetPolicies)",
      ".insert(budgetIncidents)",
      ".update(budgetIncidents)",
      ".set({ budgetMonthlyAmount: limitAmount",
      "knownSpendBy",
      "costEvents.knownDeltaAmount",
      'eq(costEvents.kind, "known")',
    ]),
    ...requireFileTokens(
      repositoryRoot,
      "apps/server/src/services/companies.ts",
      [
        "const budgets = budgetService(db)",
        "budgets.createCompany(data, actorUserId)",
        '"budgetCurrency" | "budgetMonthlyAmount"',
        "budgets.getCompanyMonthlyKnownSpend(companyIds)",
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "apps/server/src/services/agent-operational-configuration.ts",
      [
        "budgetService(txDb, budgetHooks).setAgentMonthlyLimit(",
        '"budgetMonthlyAmount"',
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/shared/src/validators/cost.ts",
      ["budgetMonthlyAmount: moneyAmountSchema", ".strict()"],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/shared/src/validators/company.ts",
      [
        "budgetCurrency: budgetCurrencySchema.optional()",
        "budgetMonthlyAmount: moneyAmountSchema.optional()",
        "export const updateCompanySchema",
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/shared/src/validators/company-portability.ts",
      [
        "budgetCurrency: budgetCurrencySchema",
        "budgetMonthlyAmount: moneyAmountSchema",
      ],
    ),
    ...requireFileTokens(repositoryRoot, "apps/server/src/routes/openapi.ts", [
      "moneyAmountSchema",
      "budgetCurrencySchema",
      "knownDeltaAmount: moneyAmountSchema.nullable()",
      "budgetMonthlyAmount: moneyAmountSchema",
    ]),
    ...requireFileTokens(repositoryRoot, "apps/ui/src/lib/utils.ts", [
      "export function formatMoneyAmount(",
      "serializeMoneyAmount(amount)",
      "currency: BudgetCurrency | string",
    ]),
    ...requireFileTokens(
      repositoryRoot,
      "apps/ui/src/routes/_authenticated/$companyId/costs/index.tsx",
      [
        "formatMoneyAmount(summary.knownSpendAmount, summary.budgetCurrency)",
        "formatMoneyAmount(summary.budgetMonthlyAmount, summary.budgetCurrency)",
        "formatMoneyAmount(summary.remainingAmount, summary.budgetCurrency)",
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "apps/ui/src/routes/_authenticated/$companyId/-BudgetPolicyCard.tsx",
      [
        "formatMoneyAmount(summary.observedAmount, summary.budgetCurrency)",
        "formatMoneyAmount(summary.limitAmount, summary.budgetCurrency)",
      ],
    ),
    ...requireFileTokens(
      repositoryRoot,
      "packages/cli/src/commands/client/cost.ts",
      [
        "updateCompanyBudgetSchema.parse(",
        "parseAgentBudgetPayload",
        '"budgetMonthlyAmount"',
        "/operational-configuration",
      ],
    ),
  ];
}

/**
 * Proves that AI budget/cost money has one denomination, one exact decimal
 * transport, and one writer graph. The independent finance ledger is allowed
 * to retain its own currency only inside its finance and company-purge owners.
 */
export function aiCostCurrencyCutoverViolations(
  repositoryRoot: string,
): string[] {
  const violations = [
    ...literalRemovalViolations(repositoryRoot, {
      forbiddenTokens: RETIRED_AI_MONEY_TOKENS,
      roots: CANONICAL_SCAN_ROOTS,
      ignoredPaths: [GATE_PATH, SELF_TEST_PATH],
    }),
    ...scanStandaloneActiveDoc(repositoryRoot, "doc/CLI.md"),
    ...budgetWriterViolations(repositoryRoot),
    ...storageAndDtoOwnershipViolations(repositoryRoot),
    ...sharedMoneyContractViolations(repositoryRoot),
    ...rawCostAggregateViolations(repositoryRoot),
    ...numberMoneyBoundaryViolations(repositoryRoot),
    ...genericPatchViolations(repositoryRoot),
    ...financeIsolationViolations(repositoryRoot),
    ...hardCodedPresentationViolations(repositoryRoot),
    ...canonicalOwnershipViolations(repositoryRoot),
  ];
  return [...new Set(violations)].sort();
}

export function assertAiCostCurrencyCutover(repositoryRoot: string): void {
  assertNoGateViolations(
    "AI cost/currency cutover check",
    aiCostCurrencyCutoverViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertAiCostCurrencyCutover(REPOSITORY_ROOT);
    console.log("AI cost/currency cutover check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
