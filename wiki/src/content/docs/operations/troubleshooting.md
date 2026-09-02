---
title: Troubleshooting
description: Map stable result codes and partial outcomes to safe recovery steps and sanitized reports.
---

Start with these sanitized views:

```text
/lsp status
/lsp policy
```

## Common result codes

| Code | What to do |
| --- | --- |
| `untrusted_project` | Review and trust the project in Pi. |
| `invalid_input` or `invalid_file` | Check paths, positions, bounds, and make a fresh preview. |
| `server_unavailable` | Check effective policy, route metadata, platform admission, and installation state. |
| `server_disabled` | Re-enable the route in global configuration if policy permits it. |
| `capability_missing` | Select a route with the required role and capability. |
| `diagnostics_timed_out` | Inspect timing and server state, then retry or restart Pi. |
| `runtime_failed` | Retry a read once; restart Pi for repeated failures. Mutations are not retried. |
| `cancelled` | Retry after the cancellation source clears. |

## Installation and diagnostics

Only the TypeScript route can be installed automatically. `server_unavailable` can mean that installation is disabled, network policy is `offline`, the route lacks a recipe, or the platform is outside verified rows. Use `/lsp install typescript` only when global policy permits it.

`diagnostics_timed_out` means no initial push diagnostic arrived before `pushGraceMs` (five seconds by default). Confirm the project is valid for the server, inspect `lsp_status`, review timings, restart Pi, and reproduce in a small project before reporting it.

## Batch and write failures

Batch results report skipped paths in `omissions` and server groups in `failures`; one group failure does not hide successes. See [batch diagnostics](/pi-lsp-manager/guides/batch-diagnostics/) for limits.

A stale or unsafe action preview is rejected before writing. Create a fresh preview. If mutation output reports recovery artifacts or incomplete rollback, stop editing the affected files, preserve the reported relative artifact names, and follow the output before restarting Pi.

A safe report includes operating system and architecture, Node, Pi, server and language versions, stable code, and sanitized `/lsp status` or `/lsp audit` output. Remove source content, credentials, paths, environment values, proxy URLs, and private repository details.

## Canonical source

[Troubleshooting reference](https://github.com/Yivas/pi-lsp-manager/blob/main/docs/troubleshooting.md)
