---
title: Configuration
description: Understand global routes, reduction-only project settings, defaults, bounds, and merge rules.
---

No configuration file is required. Defaults enable the built-in TypeScript route, automatic installation, post-edit diagnostics, and `network: "auto"` for the fixed recipe.

## Locations and layer order

The global file is `pi-lsp-manager.json` in the Pi agent directory returned by `getAgentDir()`. Managed servers and the private installation audit live in that directory's `lsp-manager` folder. A trusted project may have `.pi/pi-lsp-manager.json` at its workspace root.

Settings merge in this order: built-in defaults, global configuration, then trusted-project configuration. Invalid JSON, unknown keys, invalid types, unsafe strings, and out-of-bounds values invalidate the entire layer.

## Reduction-only project settings

A trusted project can disable a known server or automatic installation, lower priority and diagnostic timings, add excluded directory names, set `network` to `offline`, and disable post-edit diagnostics. It cannot add routes, commands, argv, environment values, initialization options, extensions, language IDs, roles, packages, URLs, or recipes. `false` and `offline` stay in effect through later layers.

The extension does not import `pi-lsp.json`, `lsp.json`, editor settings, or another extension's configuration.

## Important defaults and bounds

| Setting | Default | Bound |
| --- | --- | --- |
| `network` | `auto` | Global: `auto` or `offline`; projects can only choose `offline`. |
| `autoInstall` / `postEditDiagnostics` | `true` | Projects can only reduce them. |
| `pushGraceMs` | `5000` | Integer from 1 to 60000. |
| `settleMs` | `50` | Integer from 1 to 60000. |
| `pullGraceMs` | `250` | Integer from 1 to 60000. |
| `requestTimeoutMs` | `30000` | Integer from 1 to 60000. |
| server priority | catalog value or `0` | Integer from -10000 to 10000. |

`diagnostics.excludeDirectories` contains directory names, not paths; each layer adds names. Restart or reload Pi after changing global executable settings. Inspect the effective policy with `/lsp policy` or `lsp_status`.

For a complete manual route example, see [manual routes](/pi-lsp-manager/guides/manual-routes/). For catalog and recipe limits, see [language servers](/pi-lsp-manager/reference/servers/).

## Canonical source

[Configuration reference](https://github.com/Yivas/pi-lsp-manager/blob/main/docs/configuration.md)
