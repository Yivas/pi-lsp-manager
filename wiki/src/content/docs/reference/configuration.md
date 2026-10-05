---
title: Configuration
description: Understand global routes, reduction-only project settings, defaults, bounds, and merge rules.
---

No configuration file is required. Defaults enable the built-in TypeScript route, automatic installation, post-edit diagnostics, and `network: "auto"` for the fixed recipe.

## Locations and layer order

The global file is `pi-lsp-manager.json` in the Pi agent directory returned by `getAgentDir()`. Managed servers and the private installation audit live in that directory's `lsp-manager` folder. A trusted project may have `.pi/pi-lsp-manager.json` at its workspace root.

Settings merge in this order: built-in defaults, global configuration, then trusted-project configuration. Invalid JSON, unknown keys, invalid types, unsafe strings, and out-of-bounds values invalidate the entire layer.

## Reduction-only project settings

A trusted project can disable a known server or automatic installation, lower priority and diagnostic timings, add excluded directory names, set `network` to `offline`, and disable post-edit diagnostics. It cannot add routes, commands, argv, environment values, initialization options, settings, extensions, language IDs, roles, packages, URLs, or recipes. `false` and `offline` stay in effect through later layers.

The extension does not import `pi-lsp.json`, `lsp.json`, editor settings, or another extension's configuration.

## Per-server LSP settings

The global file may attach an optional `settings` object to a server. The extension returns it from `workspace/configuration` and re-sends it in `workspace/didChangeConfiguration` after initialization. It is separate from `initialization`, which is sent once as `initialize.initializationOptions`, is global-only, and is rejected in a project file.

Upstream settings are not a sandbox. They can allow network requests and filesystem access under your normal user permissions, and `network: "offline"` does not restrict a server that is already running.

```json
{
  "version": 1,
  "servers": {
    "yaml-language-server": {
      "settings": {
        "yaml": {
          "schemaStore": { "enable": false },
          "schemas": {
            "https://example.com/schemas/example.json": ["example.yaml"]
          }
        }
      }
    }
  }
}
```

This disables the upstream schema store and maps one public example schema to a local file pattern for `yaml-language-server`. The example only sets `settings`: loading configuration never installs or starts a server, so it neither triggers the `yaml-language-server` recipe nor verifies the route.

### Built-in JSON validation default

The built-in `vscode-json-language-server` route reports syntax and schema diagnostics only when `json.validate.enable` is true and reads an absent value as false. When the global settings for that one server are a JSON object and the value is missing as an own property at every level, the extension adds `json.validate.enable: true`, so a `json.schemas` map works without repeating it. Any value at `json`, `json.validate`, or `json.validate.enable` is kept as written and stops the default; at the leaf, any explicit `enable` also stops it (`true` enables validation, `false` disables it, and `null` is not true, so validation stays off). Sibling keys and other servers are untouched, and your configuration file is never rewritten.

The server's `settings` must still be a JSON object: a non-object invalidates the whole global layer, which is ignored, so the load falls back to the defaults where this new `true` is already present.

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
| server `settings` | unset | Bounded JSON object served through `workspace/configuration`; global only; `__proto__`, `prototype` and `constructor` rejected at any depth. |

`diagnostics.excludeDirectories` contains directory names, not paths; each layer adds names. Restart or reload Pi after changing global executable settings. Inspect the effective policy with `/lsp policy` or `lsp_status`.

For a complete manual route example, see [manual routes](/pi-lsp-manager/guides/manual-routes/). For catalog and recipe limits, see [language servers](/pi-lsp-manager/reference/servers/).

## Trusted installer interpreter (unreleased)

A future Python recipe installs its pinned wheel through a Python interpreter you name explicitly. The global config accepts the optional `pythonInterpreter` key: an absolute path of the trusted Python used only for installing Python recipes. It is global-only, must not contain shell syntax, quotes or `..` segments, and an empty or missing value leaves the install manual. The extension never resolves `python` from `PATH` and never uses a project virtual environment or the `py` launcher. The key does nothing until a Python recipe is admitted; `ty` and `ruff` stay candidates.

## Canonical source

[Configuration reference](https://github.com/Yivas/pi-lsp-manager/blob/main/docs/configuration.md)
