import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { aiCostCurrencyCutoverViolations } from "./check-ai-cost-currency-cutover.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

const presentationPaths = [
  "apps/ui/src/components/ApprovalPayload.tsx",
  "apps/ui/src/components/BudgetIncidentCard.tsx",
  "apps/ui/src/components/BudgetPolicyCard.tsx",
  "apps/ui/src/pages/AgentDetail.tsx",
  "apps/ui/src/pages/Companies.tsx",
  "apps/ui/src/pages/Costs.tsx",
  "apps/ui/src/pages/Dashboard.tsx",
  "apps/ui/src/pages/ProjectDetail.tsx",
  "apps/ui/src/pages/UserProfile.tsx",
] as const;

function fixtureRoot(): string {
  const root = mkdtempSync(
    join(tmpdir(), "paperclip-ai-cost-currency-gate-"),
  );
  roots.add(root);

  write(
    root,
    "packages/shared/src/money.ts",
    [
      "export const BUDGET_CURRENCIES = ['USD', 'EUR'] as const;",
      "export type BudgetCurrency = 'USD' | 'EUR';",
      "export function isBudgetCurrency(value: unknown): value is BudgetCurrency { return value === 'USD' || value === 'EUR'; }",
      "export function parseBudgetCurrency(value: unknown): BudgetCurrency {",
      "  if (!isBudgetCurrency(value)) throw new TypeError('invalid currency');",
      "  return value;",
      "}",
      "export type MoneyAmount = string & { readonly MoneyAmount: unique symbol };",
      "export function parseMoneyAmount(value: unknown) { return value; }",
      "export function canonicalizeMoneyAmount(value: string) { return value; }",
      "export function compareMoneyAmounts() { return 0; }",
      "export function addMoneyAmounts() { return '0'; }",
      "export function serializeMoneyAmount(value: MoneyAmount) { return value; }",
      "export const budgetCurrencySchema = z.enum(BUDGET_CURRENCIES);",
      "export const moneyAmountSchema = {};",
      "export const BUDGET_CURRENCY_OPENAPI_SCHEMA = {};",
      "export const MONEY_AMOUNT_OPENAPI_SCHEMA = {};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/shared/src/index.ts",
    "export { parseBudgetCurrency, parseMoneyAmount, moneyAmountSchema, type BudgetCurrency, type MoneyAmount } from './money.js';\n",
  );
  write(
    root,
    "packages/shared/src/validators/company.ts",
    [
      "export const createCompanySchema = { budgetCurrency: budgetCurrencySchema.optional(), budgetMonthlyAmount: moneyAmountSchema.optional() };",
      "export const updateCompanySchema = z.object({ name: z.string().optional() }).strict();",
      "export type UpdateCompany = z.infer<typeof updateCompanySchema>;",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/shared/src/validators/cost.ts",
    "export const updateCompanyBudgetSchema = z.object({ budgetMonthlyAmount: moneyAmountSchema }).strict();\n",
  );
  write(root, "packages/shared/src/validators/agent.ts", "export const agentSchema = z.object({ name: z.string() });\n");
  write(root, "packages/shared/src/validators/project.ts", "export const projectSchema = z.object({ name: z.string() });\n");
  write(
    root,
    "packages/shared/src/validators/runtime-agent-configuration.ts",
    "export const runtimeAgentConfigurationSchema = z.object({ budgetMonthlyAmount: moneyAmountSchema });\n",
  );
  write(
    root,
    "packages/shared/src/validators/company-portability.ts",
    "export const portabilityCompanyManifestEntrySchema = z.object({ budgetCurrency: budgetCurrencySchema, budgetMonthlyAmount: moneyAmountSchema });\n",
  );

  write(
    root,
    "packages/db/schema/money.ts",
    [
      "export function moneyAmountColumn(name: string) { return numeric(name, { mode: \"string\" }).$type<MoneyAmount>(); }",
      "export function budgetCurrencyColumn(name: string) { return text(name).$type<BudgetCurrency>(); }",
      "export function nonnegativeFiniteMoneyCheck() {}",
      "export function supportedBudgetCurrencyCheck() {}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/companies.ts",
    [
      "export const companies = pgTable('companies', {",
      "  budgetCurrency: budgetCurrencyColumn(\"budget_currency\").notNull(),",
      "  budgetMonthlyAmount: moneyAmountColumn(\"budget_monthly_amount\").notNull(),",
      "}, (table) => [unique(\"companies_id_budget_currency_uq\")]);",
      "check(\"companies_budget_currency_check\", supportedBudgetCurrencyCheck(table.budgetCurrency));",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/agents.ts",
    [
      "export const agents = pgTable('agents', {",
      "  budgetMonthlyAmount: moneyAmountColumn(\"budget_monthly_amount\").notNull(),",
      "});",
      "check(\"agents_budget_monthly_amount_check\", nonnegativeFiniteMoneyCheck(table.budgetMonthlyAmount));",
      "",
    ].join("\n"),
  );
  write(root, "packages/db/schema/projects.ts", "export const projects = pgTable('projects', { id: uuid('id') });\n");
  write(
    root,
    "packages/db/schema/budget_policies.ts",
    [
      "export const budgetPolicies = pgTable('budget_policies', {",
      "  limitAmount: moneyAmountColumn(\"limit_amount\").notNull(),",
      "});",
      "check(\"budget_policies_limit_amount_check\", nonnegativeFiniteMoneyCheck(table.limitAmount));",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/budget_incidents.ts",
    [
      "export const budgetIncidents = pgTable('budget_incidents', {",
      "  limitAmount: moneyAmountColumn(\"limit_amount\").notNull(),",
      "  observedAmount: moneyAmountColumn(\"observed_amount\").notNull(),",
      "});",
      "check(\"budget_incidents_amounts_check\", nonnegativeFiniteMoneyCheck(table.limitAmount));",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/agent_runtime_state.ts",
    [
      "export const agentRuntimeState = pgTable('agent_runtime_state', {",
      "  aggregateKnownCostAmount: moneyAmountColumn(",
      "    \"aggregate_known_cost_amount\",",
      "  ).notNull(),",
      "});",
      "check(\"agent_runtime_state_aggregates_check\", nonnegativeFiniteMoneyCheck(table.aggregateKnownCostAmount));",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/cost_events.ts",
    [
      "export const costEvents = pgTable('cost_events', {",
      "  knownDeltaAmount: moneyAmountColumn(\"known_delta_amount\"),",
      "});",
      "check(\"cost_events_transition_check\", sql`${table.observedCurrency} = ${table.budgetCurrency}`);",
      "foreignKey({ name: \"cost_events_company_budget_currency_fk\" });",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/finance_events.ts",
    [
      "export const financeEvents = pgTable('finance_events', {",
      "  amount: moneyAmountColumn(\"amount\").notNull(),",
      "  currency: text(\"currency\").notNull(),",
      "});",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/db/schema/index.ts",
    "export { financeEvents } from './finance_events.js';\n",
  );

  write(
    root,
    "apps/server/src/services/budgets.ts",
    [
      "async function upsertPolicyInTransaction() {",
      "  const budgetCurrency = parseBudgetCurrency(data.budgetCurrency ?? \"USD\");",
      "  companyCurrency(transaction, companyId, true);",
      "  resolveScopeRecord(transaction, scopeType, scopeId, true);",
      "  query.for(\"update\");",
      "  db.update(budgetPolicies);",
      "  db.insert(budgetPolicies);",
      "  db.insert(budgetIncidents);",
      "  db.update(budgetIncidents);",
      "  db.update(companies).set({ budgetMonthlyAmount: limitAmount });",
      "  db.update(agents).set({ budgetMonthlyAmount: limitAmount });",
      "}",
      "function knownSpendBy() {",
      "  eq(costEvents.kind, \"known\");",
      "  return sql`sum(${costEvents.knownDeltaAmount}) filter (where ${costEvents.kind} = 'known')`;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/companies.ts",
    [
      "const budgets = budgetService(db);",
      "budgets.createCompany(data, actorUserId);",
      "type Locked = Omit<Row, \"budgetCurrency\" | \"budgetMonthlyAmount\">;",
      "budgets.getCompanyMonthlyKnownSpend(companyIds);",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/agent-operational-configuration.ts",
    [
      "budgetService(txDb, budgetHooks).setAgentMonthlyLimit(",
      "  companyId, agentId, configuration.budgetMonthlyAmount, actorUserId,",
      ");",
      "const owned = \"budgetMonthlyAmount\";",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/finance.ts",
    "db.select({ currency: financeEvents.currency, amount: financeEvents.amount }).from(financeEvents);\n",
  );
  write(
    root,
    "apps/server/src/routes/openapi.ts",
    [
      "const moneyAmountSchema = z.string();",
      "const budgetCurrencySchema = z.string();",
      "const event = { knownDeltaAmount: moneyAmountSchema.nullable() };",
      "const company = { budgetMonthlyAmount: moneyAmountSchema };",
      "",
    ].join("\n"),
  );

  write(
    root,
    "apps/ui/src/lib/utils.ts",
    [
      "export function formatMoneyAmount(amount: MoneyAmount, currency: BudgetCurrency | string) {",
      "  return `${currency} ${serializeMoneyAmount(amount)}`;",
      "}",
      "",
    ].join("\n"),
  );
  for (const path of presentationPaths) {
    const source = path.endsWith("/Costs.tsx")
      ? [
          "formatMoneyAmount(summary.knownSpendAmount, summary.budgetCurrency);",
          "formatMoneyAmount(summary.budgetMonthlyAmount, summary.budgetCurrency);",
          "formatMoneyAmount(summary.remainingAmount, summary.budgetCurrency);",
          "",
        ].join("\n")
      : path.endsWith("/BudgetPolicyCard.tsx")
        ? [
            "formatMoneyAmount(summary.observedAmount, summary.budgetCurrency);",
            "formatMoneyAmount(summary.limitAmount, summary.budgetCurrency);",
            "",
          ].join("\n")
        : "const rendered = formatMoneyAmount(amount, currency);\n";
    write(root, path, source);
  }
  write(
    root,
    "packages/cli/src/commands/client/cost.ts",
    [
      "updateCompanyBudgetSchema.parse(payload);",
      "parseAgentBudgetPayload(payload);",
      "const field = \"budgetMonthlyAmount\";",
      "const path = \"/operational-configuration\";",
      "",
    ].join("\n"),
  );
  write(root, "doc/CLI.md", "Money values use canonical decimal strings.\n");
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts the canonical decimal-string budget graph and isolated finance currency", () => {
  assert.deepEqual(aiCostCurrencyCutoverViolations(fixtureRoot()), []);
});

for (const token of [
  "budgetMonthlyCents",
  "spentMonthlyCents",
  "costCents",
  "amountCents",
  "limitCents",
  "billed_cents",
  "costUsd",
  "formatCents",
] as const) {
  test(`rejects retired AI money token ${token}`, () => {
    const root = fixtureRoot();
    write(
      root,
      "apps/server/src/services/retired-money.ts",
      `export const retired = ${JSON.stringify(token)};\n`,
    );
    assert.ok(
      aiCostCurrencyCutoverViolations(root).some((entry) =>
        entry.includes(token),
      ),
    );
  });
}

test("allows a retired literal only in an explicitly marked negative test", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/money-removal.test.ts",
    [
      "// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: costCents",
      "expect(value).not.toHaveProperty('costCents');",
      "",
    ].join("\n"),
  );
  assert.deepEqual(aiCostCurrencyCutoverViolations(root), []);
});

test("rejects JavaScript-number money fields and JSON examples", () => {
  const root = fixtureRoot();
  write(
    root,
    "packages/shared/src/types/rogue-cost.ts",
    "export interface RogueCost { knownCostAmount: number; }\n",
  );
  write(
    root,
    "apps/server/src/routes/rogue-money.ts",
    "const body = { budgetMonthlyAmount: 12.5 };\n",
  );
  const violations = aiCostCurrencyCutoverViolations(root);
  assert.equal(
    violations.filter((entry) => entry.includes("JavaScript-number boundary"))
      .length,
    2,
  );
});

test("rejects renamed cents-only money status and DTO fields", () => {
  const root = fixtureRoot();
  write(
    root,
    "packages/shared/src/types/rogue-status.ts",
    "export interface RogueStatus { totalKnownCostCents: string; }\n",
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("cents-only AI money status or DTO"),
    ),
  );
});

test("rejects subordinate currency, project-limit, and stored-spend owners", () => {
  const root = fixtureRoot();
  write(
    root,
    "packages/db/schema/projects.ts",
    [
      "export const projects = pgTable('projects', {",
      "  budgetCurrency: budgetCurrencyColumn('budget_currency').notNull(),",
      "  budgetMonthlyAmount: moneyAmountColumn('budget_monthly_amount').notNull(),",
      "  spentMonthlyAmount: moneyAmountColumn('spent_monthly_amount').notNull(),",
      "});",
      "",
    ].join("\n"),
  );
  const violations = aiCostCurrencyCutoverViolations(root);
  assert.ok(violations.some((entry) => entry.includes("second currency")));
  assert.ok(violations.some((entry) => entry.includes("project limit")));
  assert.ok(violations.some((entry) => entry.includes("derived spend")));
});

test("rejects an agent or project request currency selector", () => {
  const root = fixtureRoot();
  write(
    root,
    "packages/shared/src/validators/agent.ts",
    "export const createAgentSchema = z.object({ budgetCurrency: budgetCurrencySchema });\n",
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("input can supply a second budget currency"),
    ),
  );
});

test("rejects direct policy, incident, and retained-limit writers", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/rogue-budget.ts",
    [
      "import { budgetPolicies as policies, budgetIncidents } from '@paperclipai/db';",
      "const incidents = budgetIncidents;",
      "db.insert(policies).values({});",
      "db.insert(schema.budgetPolicies).values({});",
      "db.update(incidents).set({});",
      "db.update(agents).set({ budgetMonthlyAmount: nextLimit });",
      "",
    ].join("\n"),
  );
  const violations = aiCostCurrencyCutoverViolations(root);
  assert.ok(violations.some((entry) => entry.includes("budgetPolicies")));
  assert.ok(violations.some((entry) => entry.includes("budgetIncidents")));
  assert.ok(violations.some((entry) => entry.includes("monthly-limit projection")));
});

test("rejects company currency mutation and database defaults", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/rogue-currency.ts",
    "db.update(companies).set({ budgetCurrency: 'EUR' });\n",
  );
  const companyPath = "packages/db/schema/companies.ts";
  write(
    root,
    companyPath,
    readFileSync(join(root, companyPath), "utf8").replace(
      'budgetCurrencyColumn("budget_currency").notNull()',
      'budgetCurrencyColumn("budget_currency").notNull().default("USD")',
    ),
  );
  const violations = aiCostCurrencyCutoverViolations(root);
  assert.ok(violations.some((entry) => entry.includes("mutates immutable")));
  assert.ok(
    violations.some((entry) => entry.includes("defaults in PostgreSQL")),
  );
});

test("rejects generic budget and spend PATCH surfaces", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/routes/rogue-company.ts",
    [
      "router.patch('/:id', async (req) => {",
      "  await updateCompany(req.params.id, { budgetMonthlyAmount: req.body.budgetMonthlyAmount });",
      "});",
      "",
    ].join("\n"),
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("generic PATCH"),
    ),
  );
});

test("rejects raw or unfenced cost summation", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/rogue-costs.ts",
    [
      "const total = sql`sum(${costEvents.observedCumulativeAmount})`;",
      "const other = sql`sum(${costEvents.knownDeltaAmount})`;",
      "",
    ].join("\n"),
  );
  const violations = aiCostCurrencyCutoverViolations(root);
  assert.ok(
    violations.some((entry) => entry.includes("instead of knownDeltaAmount")),
  );
  assert.ok(
    violations.some((entry) => entry.includes("not fenced to known")),
  );
});

test("rejects a finance-ledger edge into AI budget accounting", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/budgets.ts";
  write(
    root,
    path,
    `${readFileSync(join(root, path), "utf8")}\nconst leaked = financeEvents.currency;\n`,
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("AI accounting queries the finance ledger"),
    ),
  );
});

test("rejects AI budget currency as a finance aggregation dependency", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/finance.ts",
    "db.select({ currency: companies.budgetCurrency }).from(financeEvents);\n",
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("finance aggregation depends on AI"),
    ),
  );
});

test("rejects hard-coded AI currency presentation", () => {
  const root = fixtureRoot();
  write(root, "apps/ui/src/pages/Costs.tsx", "const rendered = '$12.50';\n");
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("hard-coded AI money presentation"),
    ),
  );
});

test("rejects a literal dollar prefix before a template interpolation", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/ui/src/pages/Costs.tsx",
    "const rendered = `$${amount}`;\n",
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("hard-coded AI money presentation"),
    ),
  );
});

test("fails closed when matching-currency cost transitions are removed", () => {
  const root = fixtureRoot();
  const path = "packages/db/schema/cost_events.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replace(
      "${table.observedCurrency} = ${table.budgetCurrency}",
      "${table.observedCurrency} <> ${table.budgetCurrency}",
    ),
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("table.observedCurrency} = ${table.budgetCurrency}"),
    ),
  );
});

test("fails closed when canonical creation no longer owns the USD default", () => {
  const root = fixtureRoot();
  const path = "apps/server/src/services/budgets.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replace(
      'parseBudgetCurrency(data.budgetCurrency ?? "USD")',
      "parseBudgetCurrency(data.budgetCurrency)",
    ),
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes('parseBudgetCurrency(data.budgetCurrency ?? "USD")'),
    ),
  );
});

test("rejects a non-uppercase catalog member and currency normalization", () => {
  const root = fixtureRoot();
  const path = "packages/shared/src/money.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8")
      .replace("['USD', 'EUR']", "['USD', 'eur']")
      .replace(
        "if (!isBudgetCurrency(value))",
        "value = String(value).trim().toUpperCase();\n  if (!isBudgetCurrency(value))",
      ),
  );
  const violations = aiCostCurrencyCutoverViolations(root);
  assert.ok(
    violations.some((entry) => entry.includes("non-uppercase ISO-shaped")),
  );
  assert.ok(
    violations.some((entry) => entry.includes("normalizes, coerces")),
  );
});

test("fails closed when the company-aware budget UI formatter is bypassed", () => {
  const root = fixtureRoot();
  const path = "apps/ui/src/components/BudgetPolicyCard.tsx";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replace(
      "formatMoneyAmount(summary.limitAmount, summary.budgetCurrency)",
      "summary.limitAmount",
    ),
  );
  assert.ok(
    aiCostCurrencyCutoverViolations(root).some((entry) =>
      entry.includes("BudgetPolicyCard.tsx") &&
      entry.includes("formatMoneyAmount(summary.limitAmount"),
    ),
  );
});

for (const token of [
  "parseBudgetCurrency",
  "parseMoneyAmount",
  "compareMoneyAmounts",
  "moneyAmountSchema",
] as const) {
  test(`fails closed when the shared money owner loses ${token}`, () => {
    const root = fixtureRoot();
    const path = "packages/shared/src/money.ts";
    write(
      root,
      path,
      readFileSync(join(root, path), "utf8").replaceAll(
        token,
        `removed_${token}`,
      ),
    );
    const violations = aiCostCurrencyCutoverViolations(root);
    assert.ok(
      violations.some((entry) =>
        entry.includes("packages/shared/src/money.ts") &&
        entry.includes("missing canonical ownership token") &&
        entry.includes(token),
      ),
    );
  });
}
