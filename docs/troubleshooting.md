# Troubleshooting

> Batch diagnostics, source fixes, manual routes, and expanded status are Unreleased source/main capabilities. npm `0.1.0` exposes the published single-file v1 tools.

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

The built-in TypeScript route is the only auto-installable entry. The other catalog IDs are candidates for manual configuration, not compatibility claims.

## Automatic installation is disabled or offline

The result is `server_unavailable` with manual recovery text when `autoInstall` is disabled, the effective network policy is `offline`, the server has no recipe, or the platform is outside the recipe's verified rows. Run `/lsp install typescript` only for the built-in TypeScript recipe when global policy permits it, or install a manual-route server yourself and configure its complete global route. A project file cannot supply executable settings.

## Installation fails

Use `/lsp audit` for sanitized decision history. Common causes are:

- registry or proxy failure;
- package integrity mismatch;
- unavailable platform recipe;
- lock timeout from another active installer;
- executable version mismatch after installation.

Retry only after resolving the reported cause. Do not delete managed directories while Pi is running. Status checks, discovery, and manual routes do not create installation state.

## Diagnostics time out

`diagnostics_timed_out` means the client did not receive the initial asynchronous publication within the configured `pushGraceMs` (5 seconds by default). If navigation works but diagnostics keep timing out:

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

If a mutation reports recovery artifacts or an incomplete rollback, stop editing the affected files. Preserve the reported relative artifact names and follow the output instructions before restarting Pi.

## Post-edit diagnostics do not appear

Post-edit checks run only after Pi's successful `edit` or `write` tools, and only when the project is trusted and both global and project policy leave `postEditDiagnostics` enabled. They do not run recursively after LSP mutations.

## Status and activity

`lsp_status` includes `trusted`, `network`, `autoInstall`, `postEditDiagnostics`, and one sanitized record per server. Each record includes `id`, `enabled`, `priority`, `available`, `autoInstall`, `runnable`, `admission`, `roles`, `extensions`, `routeConfigured`, `recipePresent`, `installable`, and `runtime` (`active` or `inactive`). Untrusted status is global-only and includes an action telling you to trust the project.

While any `lsp_*` tool or `/lsp` operation is running in a UI context, Pi shows the generic `LSP working` activity status. It does not include request arguments or file names and clears when all LSP work ends.

## Collecting a safe report

Include:

- operating system and architecture;
- Node, Pi, server, and language-version information;
- the stable result code;
- a minimal public fixture if possible;
- relevant sanitized `/lsp status` or `/lsp audit` output.

Remove credentials, source content, private paths, environment values, proxy URLs, and internal repository information before posting.
