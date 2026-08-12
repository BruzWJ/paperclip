# Invite and Join Flow

Status: current

Paperclip company invites are only for user membership. Agent creation and
configuration are board operations backed by ACPX and never use the invite
channel.

## User invite

1. A board user creates a company invite with one canonical `userRole`.
2. The recipient authenticates as a user and accepts the invite with an empty
   request body.
3. Paperclip records the join request, activates the company membership with
   the invited role, and audits the concrete inviter and accepting user.

Invite creation, acceptance, and any join-request decision are company-scoped
and idempotent at their declared identities. No invite operation creates an
agent, provider configuration, provider session, or generic credential.
