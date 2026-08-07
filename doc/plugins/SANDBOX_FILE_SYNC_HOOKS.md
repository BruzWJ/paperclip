# Sandbox file-transfer lifecycle hooks

This is an internal execution-provider contract, not a board configuration
surface. An execution provider moves run-directory and asset files between the
host and sandbox around a run. The baseline runtime performs that transfer over
the `environmentExecute` verb by base64-encoding bounded chunks and piping them
through `base64 -d` shell commands. It is portable, but it cannot use a
provider's native bulk-file transport.

Providers may advertise the two lifecycle hooks below to implement the same
orchestrator-owned transfers with their native transport:

- `onEnvironmentSyncIn` — before execution, place host files and directories
  at sandbox paths.
- `onEnvironmentSyncOut` — after execution, copy sandbox files and directories
  back to host paths.

These hooks only change the implementation of an already-authorized runtime
transfer. They do not create an operator-facing configuration or file surface.

## Capability negotiation and fallback

A `PluginDefinition` advertises a hook in `InitializeResult.supportedMethods`
by defining it. Leaving it undefined omits the corresponding method, and a
guarded call returns `METHOD_NOT_IMPLEMENTED`.

**The hooks are consumed as a pair.** The runtime uses the native transfer path
only when the provider advertises both `environmentSyncIn` and
`environmentSyncOut`. If either is absent, it uses the baseline transfer in both
directions. This keeps the observable file result identical for all providers.

```ts
export default definePlugin({
  async setup() { /* ... */ },
  async onEnvironmentSyncIn(params) {
    return { operations: await transferInbound(params) };
  },
  async onEnvironmentSyncOut(params) {
    return { operations: await transferOutbound(params) };
  },
});
```

## Operation and mapping contract

Each hook receives an ordered list of operations. An operation has an opaque ID
and one or more source-to-target mappings:

```ts
interface PluginSyncOperation {
  operationId: string; // opaque, non-sensitive; do not interpret it
  files: PluginSyncFileMapping[];
}

interface PluginSyncFileMapping {
  sourcePath: string; // absolute
  targetPath: string; // absolute
  kind: "file" | "directory";
  mode?: number; // POSIX mode at the target
  exclude?: string[]; // glob excludes for a directory mapping
  followSymlinks?: boolean;
}

interface PluginEnvironmentSyncResult {
  operations: {
    operationId: string;
    filesTransferred: number;
    bytesTransferred: number;
  }[];
}
```

For `onEnvironmentSyncIn`, `sourcePath` is a host path and `targetPath` is a
sandbox path. `onEnvironmentSyncOut` reverses that direction. All sandbox paths
use POSIX separators. Return `filesTransferred` and `bytesTransferred` for each
operation for runtime observability.

### Ordering and ownership

Apply operations in array order. The orchestrator invokes inbound transfer
before execution and outbound transfer after execution. It owns what is moved,
where it is moved, and when it is moved; a provider must execute the opaque
transfers it receives without reordering or widening them.

`operationId` is authored by the orchestrator. It is non-sensitive and safe to
log, but a provider must not parse it, derive a path from it, or rely on its
format.

### Transport implementation

The mapping describes the observable result, not the transport. Bulk upload,
an internal `tar` stream, or per-file enumeration are all valid. The
materialized target must have the same files, contents, modes, and symlink
treatment as the baseline transfer so implementations remain interchangeable.

## Symlinks

`followSymlinks` applies only to `kind: "directory"` mappings and matches
`tar -h` semantics:

- falsy (the default): preserve symlinks as links;
- `true`: dereference each symlink to its target bytes.

A provider handling a directory mapping must reproduce that result. There is no
separate extraction-side switch; symlink treatment is carried solely by this
field.

## Atomicity and failures

Native transfers must preserve the baseline integrity floor:

- **Single-file mappings are atomic-replace.** Stage bytes at a temporary path
  in the same directory and filesystem as `targetPath`, then atomically rename
  them into place. Do not leave a truncated target after an interrupted
  transfer. Reserve `.paperclip-upload*` scratch names to avoid colliding with
  the baseline transport or a real target.
- **Directory mappings are not transactional.** They are
  destroy-then-replace operations and may leave a partial tree after a crash.
  Deliver an individually integrity-sensitive file as its own file mapping so
  it receives atomic replacement.
- **Every operation fails loudly.** Complete it or raise to the orchestrator;
  never report partial success as successful. The runtime can then retry or use
  its baseline transfer.

## Secret material and modes

Mappings can contain credential-bearing files. For those files, `mode` is
required in practice:

- Apply the requested mode (for example `0o600`) without a world-readable
  interval: create with the mode or chmod before writing bytes, never after.
- Honor modes for files inside directory mappings as well as direct file
  mappings. A `tar` implementation must preserve permissions; an enumerating
  implementation must apply them as each file lands.
- Directory transfer is not atomic. If an individual secret needs integrity
  protection, send it as a direct file mapping or protect its integrity outside
  this transport.

## Host-side path confinement

The sandbox is untrusted relative to the host. The orchestrator, rather than
the provider, owns and confines every source and target path before handing an
operation to the provider. It canonicalizes a path and restricts it to an
orchestrator-owned run directory or specific asset directory, rejecting absolute
escapes and `..` traversal fail-closed.

Providers receive only orchestrator-authored, already-confined paths. They must
not widen them, including by following a sandbox-planted outbound symlink beyond
the intended root. Path confinement is complete mediation at the host boundary;
it is never delegated to a provider.

## Resource bounds and shell safety

The baseline transport has transfer caps to avoid unbounded memory use. Native
providers must retain equivalent bounds: stream or chunk large transfers and
fail closed on an oversized inline payload.

If a provider builds a shell command (for example a pod-exec
`tar`/`base64`/`mv` pipeline), it must single-quote every interpolated path so
shell metacharacters are transferred literally. A typed non-shell bulk-upload
API does not need shell quoting.

## Minimal shape

```ts
async onEnvironmentSyncIn({ operations }) {
  const results = [];
  for (const operation of operations) {
    let filesTransferred = 0;
    let bytesTransferred = 0;
    for (const file of operation.files) {
      if (file.kind === "file") {
        // Stage in the target directory, apply mode safely, then rename.
      } else {
        // Materialize source at target, honoring excludes and symlink handling.
      }
    }
    results.push({
      operationId: operation.operationId,
      filesTransferred,
      bytesTransferred,
    });
  }
  return { operations: results };
}
```
