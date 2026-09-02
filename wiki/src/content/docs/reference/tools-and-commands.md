---
title: Tools and commands
description: Choose the LSP tool or command that matches a read, mutation, installation, or status task.
---

File-based LSP tools require a trusted project. `lsp_status` is the safe read-only exception: it can return sanitized global policy and availability state without reading project configuration or starting a server. The explicit installation command has a separate narrow contract described below.

| Tool | Purpose |
| --- | --- |
| `lsp_diagnostics` | Check one file with `filePath`, or scan workspace paths with `paths`, `servers`, `fileLimit`, `limit`, and `severity`. |
| `lsp_definition` | Find definitions at a UTF-16 position. |
| `lsp_references` | Find references at a UTF-16 position. |
| `lsp_symbols` | List document or workspace symbols. |
| `lsp_prepare_rename` | Validate and preview a rename target. |
| `lsp_rename` | Prepare the requested position again, request a rename, and apply the validated workspace edit. |
| `lsp_code_actions` | Preview code actions; it never writes. |
| `lsp_fix` | Preview source actions, or apply one unambiguous action with `write: true`. |
| `lsp_apply_code_action` | Apply one current action preview. |
| `lsp_status` | Return sanitized trust, policy, route, installation, and runtime state. |

## Commands

```text
/lsp status
/lsp policy
/lsp install <id>
/lsp warmup <id>
/lsp audit
```

`/lsp install <id>` installs only a built-in recipe allowed by global policy. It does not read project files or start the server. `/lsp warmup <id>` starts an already installed, available server for a trusted project and never installs it. `/lsp audit` reports sanitized installation decisions.

Pi shows `LSP working` while any LSP tool or `/lsp` operation runs in a UI context. It clears when all work ends and does not expose request arguments or file names.

See [batch diagnostics](/pi-lsp-manager/guides/batch-diagnostics/) and [source actions](/pi-lsp-manager/guides/source-actions/) for behavior and limits.

## Canonical source

[Tool and command summary](https://github.com/Yivas/pi-lsp-manager/blob/main/README.md)
