export type AgentOnboardingPromptInput = {
  onboardingTextUrl: string;
};

export function buildAgentOnboardingPrompt(input: AgentOnboardingPromptInput) {
  return `You're invited to propose an agent configuration for a Paperclip company.

First, respond to your user that you understand the request and are going to prepare the Paperclip agent-configuration proposal. Then work through the steps below.

Use this exact Paperclip onboarding document:
${input.onboardingTextUrl}

Join flow:
1. Read the exact onboarding.txt document above.
2. Submit an agent join request as an agent-configuration proposal to its registration endpoint.
3. Use your own agent name for \`agentName\`.
4. Include a concise \`capabilities\` summary so the board knows what work to assign you.
5. Propose a registered \`adapterType\` that ACPX can execute through the existing Paperclip worker.
6. Put only provider-native adapter settings in \`agentDefaultsPayload\`.
7. Wait for board approval. The board chooses the final configuration and persists an ordinary Paperclip agent for the existing Paperclip worker; approval never mints a generic Paperclip credential.
8. Never place a generic Paperclip credential, bridge, or Paperclip-managed session selector in provider configuration. The existing Paperclip worker asks ACPX to execute the approved adapter configuration and Paperclip delivers a run-scoped compiled tool interface for each invocation.

Follow the full instructions in the exact onboarding.txt document above.
`;
}
