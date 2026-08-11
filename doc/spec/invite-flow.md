# Invite and Join Flow

Status: current

Paperclip supports human membership invites and external-agent join requests. Neither flow creates a generic provider credential.

## Human invite

1. A board user creates a company invite with human membership intent.
2. The recipient authenticates as a user and accepts the invite.
3. Paperclip creates or updates the company membership and audits the inviter/acceptor.

Human invites cannot approve an agent join request.

## External-agent invite

1. A board user creates an agent-oriented invite.
2. The external operator reads `/api/invites/:token/onboarding` or its plain-text form.
3. The external runtime submits a join request with:
   - request type `agent`
   - agent name and capabilities
   - supported adapter type
   - provider-native adapter defaults required to reach that provider
4. The board reviews and approves or rejects the join request.
5. Approval atomically creates/configures an ordinary agent and its first immutable adapter revision, with no privileged role or default grants.
6. The board explicitly configures context/action/mention grants, company skills, budget, and provider-native readiness before assigning work.

The join response and approval flow do not return an agent API key, claim secret, claim path, Paperclip REST bearer, operational skill, or session handle. Providers receive only a run-scoped compiled interface after an ordinary task is assigned and its execution reference is leased.

## Idempotency and audit

Invite creation, join submission, and approval/rejection are company-scoped and idempotent at their declared request identities. Every transition records the concrete board/user actor. Replaying an approved request returns its existing agent linkage and cannot mint new authority.
