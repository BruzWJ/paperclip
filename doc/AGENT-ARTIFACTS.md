# Issue Artifacts and Provider Outputs

Paperclip keeps provider execution and board artifact management as separate
boundaries.

An agent may create files in the current run directory. The provider receives
that directory as its process working directory. It does not receive a
Paperclip API URL, API credential, company, agent, run, issue, or attachment
identifier, and it cannot upload an attachment or create a work product through
generic Paperclip REST.

## Provider Output

When work produces a file, the agent should:

1. Write the file in the current run directory.
2. Verify the file there.
3. Name its relative path in the normal final response.

The productive run records that response once as the issue's `run_output`
comment. A path in the response is descriptive output, not an authorization
token and not a durable upload.

The only Paperclip capability available inside a provider invocation is its
run-scoped `paperclip.run-tools/v1` interface. That interface contains the
retrieval, action, and mention capabilities compiled for the current issue
execution. It has no generic attachment, work-product, filesystem, or REST
escape hatch.

## Board Artifact Management

An authenticated board user may upload an issue attachment and create an
attachment-backed work product through the board API or UI.

An attachment-backed artifact work product uses `type: "artifact"` and
`provider: "paperclip"` with metadata that identifies an attachment already
uploaded to the same issue. The server canonicalizes the attachment's content
type, byte size, storage paths, and original filename.

## Boundary

Board-side artifact APIs are control-plane operations. They are not provider
tools, provider environment conventions, operational skills, or implicit
post-run upload hooks. Paperclip does not copy arbitrary provider files,
translate a model-supplied local path into a board attachment, or grant a
provider general API access so it can do so itself.

This separation preserves the issue-scoped execution model: providers report
their output; board users decide which files become durable Paperclip artifacts.
