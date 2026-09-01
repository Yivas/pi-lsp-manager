# Troubleshooting

Start with `/lsp status`, `/lsp policy`, and `lsp_status`. These surfaces report stable states without exposing private paths.

## Project is not trusted

**Result:** `project_untrusted` or tools remain unavailable.

Trust the project through Pi only after reviewing it. The extension will not read project configuration, start a server, or run diagnostics before that decision.

## No server is selected

**Result:** `no_server` or `unsupported_file`.

Check that:

1. the file has a supported extension;
2. the built-in server is enabled;
3. its role covers the requested operation;
4. `lsp_status` reports the executable as available or installable.

The v1 catalog supports TypeScript and JavaScript extensions only.

## Automatic installation is disabled

**Result:** `installation_required` with a manual command.

Run `/lsp install typescript` if policy permits it, or install TypeScript Language Server yourself and configure the global executable. A project file cannot supply executable settings.

## Network is offline

**Result:** `network_offline`.

Change the global network policy to `auto`, or perform a reviewed manual installation. Project configuration cannot loosen an offline global policy.

## Installation fails

Use `/lsp audit` for the sanitized decision history. Common causes are:

- registry or proxy failure;
- package integrity mismatch;
- unavailable platform recipe;
- lock timeout from another active installer;
- executable version mismatch after installation.

Retry only after resolving the reported cause. Do not delete managed directories while Pi is running.

## Diagnostics time out

**Result:** `diagnostics_timed_out`.

The TypeScript server publishes diagnostics asynchronously. The extension waits up to five seconds for the initial publication. If navigation works but diagnostics keep timing out:

1. confirm the file belongs to a valid TypeScript or JavaScript project;
2. inspect the server state with `lsp_status`;
3. restart the Pi session to discard a tainted process;
4. reproduce with a minimal project before reporting the problem.

An empty diagnostic list is a valid successful result for a clean file.

## Runtime failure

**Result:** `runtime_failed`.

The server exited, violated the protocol, or failed a request. Read operations receive at most one retry with a fresh runtime. Mutations are never retried automatically. Restart the session and report a minimal reproduction if the failure is repeatable.

## Rename or code action is rejected

Common results include `preview_expired`, `file_changed`, `unsupported_workspace_edit`, and `mutation_failed`.

Generate a fresh preview and retry. If any target changed since preview, the whole operation is rejected before commit. Resource operations and overlapping edits are intentionally unsupported.

If the result is `manual_recovery` or `rollback_incomplete`, stop editing the affected files. Preserve the reported relative recovery artifacts and follow the output instructions before restarting Pi.

## Post-edit diagnostics do not appear

Post-edit checks run only after Pi's successful `edit` or `write` tools, and only when both global and project policy leave `postEditDiagnostics` enabled. They do not run recursively after LSP mutations.

## Collecting a safe report

Include:

- operating system and architecture;
- Node, Pi, TypeScript Language Server, and TypeScript versions;
- the stable result code;
- a minimal public fixture if possible;
- relevant sanitized `/lsp status` or `/lsp audit` output.

Remove credentials, source content, private paths, and internal repository information before posting.
