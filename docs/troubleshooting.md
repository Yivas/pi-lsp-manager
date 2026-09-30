# Troubleshooting

Start with `/lsp status`, `/lsp policy`, and `lsp_status`. These surfaces report stable state without exposing private paths, command arguments, or route environment values.

## Stable tool error codes

Tool failures expose one of these codes with short recovery text:

| Code | Meaning | Recovery |
|-|-|-|
| `untrusted_project` | The project has not been trusted by Pi. | Trust the project before using LSP tools, warmup, or post-edit diagnostics. |
| `invalid_input` | A tool argument is malformed or exceeds a bound. | Check the tool schema and the limits below. |
| `invalid_file` | The path, position, preview, or workspace edit is invalid. | Use a regular file inside the workspace and create a fresh preview when needed. |
| `server_unavailable` | No selected route is runnable, or policy does not allow its installation. | Check `lsp_status`, configure the global route, or install the server manually. |
| `server_disabled` | The selected server is disabled by effective policy. | Re-enable it in the global configuration if the policy allows. |
| `capability_missing` | The selected server does not advertise the requested LSP capability. | Select a compatible server with the required role/capability. |
| `diagnostics_timed_out` | Initial diagnostic publication did not arrive before its grace period. | Wait for analysis, inspect status, or retry. |
| `runtime_failed` | The process, transport, or request failed. | Retry a read once; restart Pi for a repeated failure. Mutations are not automatically retried. |
| `cancelled` | The request or shutdown cancelled the operation. | Retry after the cancellation source has cleared. |

## Project is not trusted

Trust the project through Pi only after reviewing it. The extension will not read project configuration, start a server, or run diagnostics before that decision. An explicit `/lsp install <id>` is the only exception: it uses global policy, does not read project files, and does not start a server.

## No server is selected

`server_unavailable` or an `unsupported_file` omission means the effective catalog has no enabled route matching the file extension, language ID, and requested role. Check that:

1. the file has a declared extension;
2. the selected server is enabled;
3. its role covers the operation;
4. its language IDs and optional `languageIdByExtension` mapping match the file;
5. `lsp_status` reports a configured and available route.

The built-in `typescript` and `vue` routes are the auto-installable entries. The other catalog IDs are candidates for manual configuration, not compatibility claims. For the Vue route, `/lsp install vue` or an authorized tool request installs the pinned `@vue/language-server@3.3.11`, `@vue/typescript-plugin@3.3.11`, `typescript@5.9.3` and `vue@3.5.43` closure from its internal recipe. A manual route instead needs `@vue/language-server@3.3.11`, `@vue/typescript-plugin@3.3.11`, and `typescript@5.9.3` together under one npm installation root: set a global route to an absolute Node executable and pass the absolute `<npm-root>/node_modules/@vue/language-server/bin/vue-language-server.js` path followed by `--stdio`. A global npm launcher on `PATH` alone cannot locate the plugin root. The route fails with `server_unavailable` when the plugin or TypeScript SDK is missing or has a different version.

## Automatic installation is disabled or offline

The result is `server_unavailable` with manual recovery text when `autoInstall` is disabled, the effective network policy is `offline`, the server has no recipe, or the platform is outside the recipe's verified rows. Run `/lsp install typescript` or `/lsp install vue` only for the built-in recipes when global policy permits it, or install a manual-route server yourself and configure its complete global route. A project file cannot supply executable settings.

## Installation fails

Use `/lsp audit` for sanitized decision history. Common causes are:

- registry or proxy failure;
- package integrity mismatch;
- unavailable platform recipe;
- lock timeout from another active installer;
- executable version mismatch after installation.

Retry only after resolving the reported cause. Do not delete managed directories while Pi is running. Status checks, discovery, and manual routes do not create installation state.

A residual in `/lsp audit` means the coordinator kept managed state it could not clean safely, instead of deleting it blindly:

- `termination_unconfirmed` — the package-manager process could not be confirmed stopped. That server's partial staging directory and its per-server lock are kept, so a later install of the same server and revision waits on the lock instead of overlapping a live process.
- `staging_cleanup_failed` — termination was confirmed, but removing the partial directory still failed after four retries with linear backoff (up to 5 seconds of waiting). The partial directory is kept and the lock is released.
- `lock_release_failed` — releasing the per-server lock timed out or failed, so the lock may still be held.

### Repairing a retained lock

A retained lock makes later installs of that server and revision wait, and eventually fail, until the file is gone. Repair it by hand, and only for that one file:

1. Quit Pi completely. Expected: no Pi process, and no `npm` or installer process it started, is still running for that server.
2. Open `<Pi agent directory>/lsp-manager/locks/` and read `<serverId>-<revision>.lock`. Expected: a small JSON file with `pid`, `startedAt`, `nonce`, `serverId`, and `revision`.
3. Confirm the file names the same `serverId` and `revision` you are repairing, that the process it records is not running, and that no other Pi instance owns it.
4. Delete only that lock file. Expected: retrying the install no longer stops at the `manual_lock_repair` reason.

Do not delete the `lsp-manager` directory, the `servers` tree, or any `.partial-` or `.invalid-` directory. A partial reported by a residual is the recovery artifact, and a quarantine directory is deliberate. An install that finds a lock whose owner is dead or unreadable reports `manual_lock_repair` instead of reclaiming it.

### Shutdown and cleanup budget

Shutdown is finite but not instantaneous, and it has no single deadline: each cleanup phase carries its own bound, and the filesystem work inside a phase is not itself deadline-limited. The termination proof waits up to 6.5 seconds on Windows and 4.5 seconds elsewhere; staging removal retries with linear backoff worth up to 5 seconds; lock release is bounded at 2 seconds; and the audit write is bounded at 1 second. Those fixed bounds sum to about 14.5 seconds on Windows and 12.5 seconds elsewhere, so a slow disk can take longer, but the work still completes instead of hanging.

## Diagnostics time out

`diagnostics_timed_out` means the client did not receive the initial asynchronous publication within the configured `pushGraceMs` (5 seconds by default; 15 seconds for the Vue route while its plugin analyzes the initial document). A clean Vue file with an empty publication can still take the full 15 seconds, and a cold project may time out once before a retry succeeds. If navigation works but diagnostics keep timing out:

1. confirm the file belongs to a valid project for that server;
2. inspect server state with `lsp_status`;
3. review the effective diagnostic timing;
4. restart Pi to discard a tainted process;
5. reproduce with a minimal project before reporting the problem.

An empty diagnostic list is a successful result for a clean file.

## Batch diagnostics omit or skip files

`lsp_diagnostics` accepts the legacy `filePath` form or a batch form. Batch discovery returns `omissions` rather than failing the whole request for an individual path. Omission reasons are:

- `outside_workspace`;
- `missing`;
- `symlink`;
- `non_regular`;
- `directory_excluded`;
- `file_too_large`;
- `unsupported_file` (after discovery, when no selected route matches).

Batch results also include `failures` with a server ID, affected relative paths, and a code. A failing server group does not hide successful results from other server groups. Check `filesScanned`, `filesChecked`, `serversUsed`, `truncated`, `omissions`, and `failures` together.

Discovery is deterministic: paths are canonicalized, entries are sorted, symlinks are not followed, and default or configured directory exclusions are applied. A caller can provide at most 32 paths and request at most 100 accepted files. Traversal inspects at most 10,000 filesystem entries, accepts documents up to 4 MiB, and returns at most 100 diagnostics per batch result. The output `limit` is also capped at 100. Explicitly supplied directories are traversed even when their names are in the exclusion set.

## Runtime failures and reuse

The runtime pool keys a process by canonical workspace root and server ID. Requests for the same pair reuse one healthy session and serialize document work; idle sessions are reaped after 5 minutes, and startup has a 60-second bound. Read operations receive at most one retry with a fresh runtime. Mutations are never retried automatically.

## Rename or code action is rejected

`lsp_code_actions` and `lsp_fix` create preview records. `lsp_fix` defaults to preview-only mode and `kind: "source.fixAll"`; use `kind: "source.organizeImports"` when that source action is wanted. `write: true` applies only when exactly one action is returned. Zero or multiple actions write zero bytes and return previews for selection with `lsp_apply_code_action` and its `previewId`.

A preview is tied to the current session, server, file, and content hash. If the file changed, the preview is stale, or the action returns an unsafe workspace edit, the operation is rejected before writing. Generate a fresh preview and retry. Resource operations and overlapping edits are intentionally unsupported.

If a Vue rename uses the TypeScript fallback, edits targeting another file are rejected instead of being applied without that file's content snapshot. A fresh request cannot make this fallback a cross-file rename; use another tool for that change.

If a mutation reports recovery artifacts or an incomplete rollback, stop editing the affected files. Preserve the reported relative artifact names and follow the output instructions before restarting Pi.

## Post-edit diagnostics do not appear

Post-edit checks run only after Pi's successful `edit` or `write` tools, and only when the project is trusted and both global and project policy leave `postEditDiagnostics` enabled. They do not run recursively after LSP mutations.

## Status and activity

`lsp_status` includes `trusted`, `network`, `autoInstall`, `postEditDiagnostics`, and one sanitized record per server. Each record includes `id`, `enabled`, `priority`, `available`, `autoInstall`, `runnable`, `admission`, `roles`, `extensions`, `routeConfigured`, `recipePresent`, `installable`, and `runtime` (`active` or `inactive`). `runnable` means the enabled route's executable can launch; it does not preflight Vue's plugin and TypeScript SDK. If a Vue tool still returns `server_unavailable`, check the co-located versions and global route above. Untrusted status is global-only and includes an action telling you to trust the project.

While any `lsp_*` tool or `/lsp` operation is running in a UI context, Pi shows the generic `LSP working` activity status. It does not include request arguments or file names and clears when all LSP work ends.

## Collecting a safe report

Include:

- operating system and architecture;
- Node, Pi, server, and language-version information;
- the stable result code;
- a minimal public fixture if possible;
- relevant sanitized `/lsp status` or `/lsp audit` output.

Remove credentials, source content, private paths, environment values, proxy URLs, and internal repository information before posting.
