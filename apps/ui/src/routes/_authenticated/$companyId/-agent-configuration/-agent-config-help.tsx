/* ---- Help text for (?) tooltips ---- */
export const help: Record<string, string> = {
  name: "Display name for this agent.",
  title: "Job title shown in the org chart.",
  reportsTo: "The agent this one reports to in the org hierarchy.",
  capabilities: "Describes what this agent can do. Shown in the org chart and used for task routing.",
  instruction:
    "High-level role and operating guidance Paperclip delivers when it initializes this agent's session.",
  adapterType:
    "An exact locally available agent name. Paperclip discovers its models and session configuration at runtime.",
  budgetMonthlyAmount: "Monthly spending limit in the company budget currency. 0 means no limit.",
};
