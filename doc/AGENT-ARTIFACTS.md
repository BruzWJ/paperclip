# Issue Artifacts and Workspace Outputs

Paperclip keeps provider execution and board artifact management as separate
boundaries.

An agent may create files inside the execution workspace selected for its
current issue. The provider receives that workspace as its process working
directory. It does not receive a Paperclip API URL, API credential, company,
agent, run, issue, workspace, or attachment identifier, and it cannot upload an
attachment or create a work product through generic Paperclip REST.

## Provider Output

When work produces a file, the agent should:

1. Write the file beneath the current execution workspace.
2. Verify the file in that workspace.
3. Name the workspace-relative path in its normal final response.

The productive run records that response once as the issue's `run_output`
comment. A path in the response is descriptive output, not an authorization
token and not a durable upload.

The only Paperclip capability available inside a provider invocation is its
run-scoped `paperclip.run-tools/v1` interface. That interface contains the
retrieval, action, mention, and selected company tools compiled for the current
issue execution. It has no generic attachment, work-product, filesystem, or
REST escape hatch.

## Board Artifact Management

An authenticated board user may inspect a registered issue workspace, resolve
a workspace-relative file, upload an issue attachment, and create an
attachment-backed work product through the board API or UI.

Workspace-file references use this shape:

```json
{
  "resourceRef": {
    "kind": "workspace_file",
    "issueId": "<issue-id>",
    "workspaceKind": "execution_workspace",
    "workspaceId": "<execution-workspace-id>",
    "relativePath": "dist/report.pdf",
    "line": 1,
    "column": 1,
    "displayPath": "dist/report.pdf:1:1"
  }
}
```

`workspaceKind` is `execution_workspace` or `project_workspace`. `line` and
`column` are optional. `relativePath` must remain beneath the registered
workspace root. Host-absolute paths, home-directory paths, unresolved process
working directories, and paths that escape the selected workspace are never
valid resource references.

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

This separation keeps workspace output useful while preserving the issue-scoped
execution model: providers write within their current workspace; board users
decide which files become durable Paperclip artifacts.
