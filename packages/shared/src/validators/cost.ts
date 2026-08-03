import { z } from "zod";
import { moneyAmountSchema } from "../money.js";

/** Dedicated company-limit mutation; generic company PATCH cannot write it. */
export const updateCompanyBudgetSchema = z
  .object({
    budgetMonthlyAmount: moneyAmountSchema,
  })
  .strict();

export type UpdateCompanyBudget = z.infer<typeof updateCompanyBudgetSchema>;
