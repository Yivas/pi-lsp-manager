# Configuration

`pi-lsp-manager` works without a configuration file. Defaults enable the built-in TypeScript Language Server route, automatic installation, post-edit diagnostics, and the `auto` network policy for the fixed recipe.

Version `0.2.0` includes the manual routes, batch diagnostics, source actions, and status details documented here.

## File locations

The global file is `pi-lsp-manager.json` in Pi's agent directory, as returned by `getAgentDir()`. Managed servers and the private installation audit live under `lsp-manager` in that directory.

A trusted project may add `.pi/pi-lsp-manager.json` at its workspace root. The project file is never read before Pi reports that the project is trusted.

## Global configuration

Global configuration may define complete manual routes for arbitrary server IDs. A new manual server must provide `command`, `args`, `extensions`, `roles`, and `languageIds`. `env` and `initialization` are optional. `priority` and diagnostic timing are also global settings.

Commands are an executable plus an argv array. They are not shell strings. The extension starts the executable without a shell, with the workspace root as its working directory. A route's `env` is added to the small inherited process environment; it is never accepted from project configuration.

```json
{
  "version": 1,
  "network": "auto",
  "autoInstall": true,
  "postEditDiagnostics": true,
  "diagnostics": {
    "pushGraceMs": 5000,
    "settleMs": 50,
    "pullGraceMs": 250,
    "requestTimeoutMs": 30000,
    "excludeDirectories": ["generated", "third_party"]
  },
  "servers": {
    "my-typescript": {
      "enabled": true,
      "autoInstall": false,
      "priority": 80,
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "env": { "NODE_OPTIONS": "--max-old-space-size=2048" },
      "initialization": { "locale": "en-US" },
      "extensions": [".ts", ".tsx"],
      "languageIds": ["typescript", "typescriptreact"],
      "languageIdByExtension": {
        ".ts": "typescript",
        ".tsx": "typescriptreact"
      },
      "roles": ["diagnostics", "semantic", "mutation"],
      "diagnostics": {
        "pushGraceMs": 5000,
        "settleMs": 50,
        "pullGraceMs": 250
      }
    }
  }
}
```

`initialization` is sent as LSP `initialize.initializationOptions`. A server's diagnostic timing controls the wait for push diagnostics, the settle interval, and the pull-diagnostics grace period. The global `diagnostics.requestTimeoutMs` bounds LSP requests. `excludeDirectories` contains directory names, not paths; these names are added to the default exclusion set used by batch discovery.

For a built-in catalog ID, global fields replace the corresponding catalog metadata. For a new ID, the complete route metadata is required even when the executable is already installed. A manual route has `autoInstall: false` and no internal recipe.

Unknown keys, invalid types, malformed JSON, unsafe strings, and values outside the documented bounds invalidate the entire configuration layer instead of being ignored.

## Merge and trust rules

Configuration is merged in this order:

1. built-in defaults;
2. global configuration;
3. trusted-project configuration.

A trusted project remains reduction-only. It may:

- disable a known server with `enabled: false`;
- disable automatic installation with `autoInstall: false`;
- lower or leave unchanged a known server's priority;
- set `network` to `offline`;
- set global `autoInstall` or `postEditDiagnostics` to `false`;
- lower diagnostic timings and add directory names to the exclusion set.

It cannot add servers, routes, commands, arguments, environment variables, initialization options, extensions, language IDs, roles, packages, URLs, or recipes. `false` and `offline` are sticky: a later layer cannot turn them back on or raise a reduced priority or diagnostic timing.

The extension does not automatically import `pi-lsp.json`, `lsp.json`, editor settings, or any other extension's configuration. Automatic import could execute an unreviewed command or alter the trust boundary.

## Reviewed manual migration example

Treat an old extension configuration as input for review, not as a file that this extension reads. For example, after checking the server's documentation and the executable on the machine, manually translate the reviewed values into the global file:

```json
{
  "version": 1,
  "servers": {
    "rust-analyzer": {
      "command": "rust-analyzer",
      "args": [],
      "extensions": [".rs"],
      "languageIds": ["rust"],
      "roles": ["diagnostics", "semantic", "mutation"],
      "priority": 60,
      "autoInstall": false,
      "initialization": {}
    }
  }
}
```

Review every command, argument, environment value, initialization option, extension, language ID, role, and priority before saving. The example does not test or auto-install `rust-analyzer`; it only defines a global manual route. The project file can later disable or reduce this route, but cannot redefine it.

## Network policy

- `auto` permits the built-in, version-pinned npm recipe when every policy check passes. It does not probe the network first.
- `offline` prevents installation before a package-manager process, lock, staging directory, or audit record is created.

Standard proxy environment variables may be inherited by npm during an authorized built-in installation, but they are never written to logs or audit records. Manual routes do not cause installation.

## Defaults and bounds

| Setting | Default | Bound or behavior |
|-|-|-|
| `network` | `auto` | Global values: `auto` or `offline`; project may only choose `offline`. |
| `autoInstall` | `true` | Boolean; project may only reduce it. |
| `postEditDiagnostics` | `true` | Boolean; project may only reduce it. |
| `diagnostics.pushGraceMs` | `5000` | Integer from `1` to `60000`. |
| `diagnostics.settleMs` | `50` | Integer from `1` to `60000`. |
| `diagnostics.pullGraceMs` | `250` | Integer from `1` to `60000`. |
| `diagnostics.requestTimeoutMs` | `30000` | Integer from `1` to `60000`. |
| `diagnostics.excludeDirectories` | `[]` | Directory names only; each layer adds names. |
| server `priority` | catalog value, or `0` for a new ID | Integer from `-10000` to `10000`; projects cannot raise it. |
| server `args` | required for a new ID | Array of strings; no shell expansion. |
| server `extensions` | required for a new ID | Non-empty extension array such as `.rs`. |
| server `languageIds` | required for a new ID | Non-empty LSP language-ID array. |
| server `roles` | required for a new ID | One or more of `diagnostics`, `semantic`, `mutation`. |

The built-in directory exclusions are `.git`, `.hg`, `.svn`, `node_modules`, `bower_components`, `vendor`, `dist`, `build`, `out`, `target`, `coverage`, `.nyc_output`, `.cache`, `.parcel-cache`, `.turbo`, `.next`, `.nuxt`, `tmp`, `temp`, `.tmp`, `.venv`, `venv`, `env`, `.env`, `__pycache__`, `.tox`, and `.gradle`.

Restart or reload the Pi session after changing global executable settings. Use `/lsp policy` and `lsp_status` to inspect the effective policy without exposing private paths.
