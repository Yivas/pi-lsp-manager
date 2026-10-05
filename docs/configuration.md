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

### Per-server LSP settings

`settings` is an optional, bounded JSON object that the extension serves to the server through `workspace/configuration` and re-sends in `workspace/didChangeConfiguration` after initialization. A request item without a section gets the whole object; a dotted section reads own properties only; a missing section gets `{}`. It is separate from `initialization`, which is sent once as `initialize.initializationOptions`.

`settings` is global-only. A project file that sets it invalidates that layer, and a project layer can never replace or remove the global value. The keys `__proto__`, `prototype`, and `constructor` are rejected at any depth.

These settings are upstream-specific and are not a sandbox. Holding `network: "offline"` or `autoInstall: false` does not restrict what a running server does: its settings can enable network requests and filesystem access under your normal user permissions. Review them as you would any other upstream option.

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

This turns off the upstream schema store and maps one public example schema to a local file pattern for `yaml-language-server`. The example only sets `settings`: loading configuration never installs or starts a server, so it neither triggers the `yaml-language-server` recipe nor verifies the route.

### Built-in JSON validation default

The built-in `vscode-json-language-server` route reports syntax and schema diagnostics only when `settings.json.validate.enable` is true, and it reads an absent value as false. When the effective global settings for that one server ID are a JSON object and the value is missing as an own property at every level, the extension adds `json.validate.enable: true` before serving them, so a `json.schemas` map works without repeating the switch. Any value you set at `settings.json`, `settings.json.validate`, or `settings.json.validate.enable` is kept as written and stops the default; at the leaf, any explicit `enable` also stops it — `true` enables validation, `false` disables it, and `null` is not true, so validation stays off. Sibling keys, other servers, and the rest of the file are untouched, and the extension never writes your configuration file.

The server's `settings` must still be a JSON object: a non-object `settings` invalidates the whole global layer, so that layer is ignored and the load falls back to the defaults, where this new `true` is already present. `null`, `false`, or an array is never a preserved `settings`.

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

It cannot add servers, routes, commands, arguments, environment variables, initialization options, settings, extensions, language IDs, roles, packages, URLs, or recipes. `false` and `offline` are sticky: a later layer cannot turn them back on or raise a reduced priority or diagnostic timing.

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
| server `settings` | unset | Bounded JSON object served through `workspace/configuration`; global only; `__proto__`, `prototype` and `constructor` are rejected at any depth. |

The built-in directory exclusions are `.git`, `.hg`, `.svn`, `node_modules`, `bower_components`, `vendor`, `dist`, `build`, `out`, `target`, `coverage`, `.nyc_output`, `.cache`, `.parcel-cache`, `.turbo`, `.next`, `.nuxt`, `tmp`, `temp`, `.tmp`, `.venv`, `venv`, `env`, `.env`, `__pycache__`, `.tox`, and `.gradle`.

Restart or reload the Pi session after changing global executable settings. Use `/lsp policy` and `lsp_status` to inspect the effective policy without exposing private paths.

## Trusted installer interpreter (unreleased)

A future Python recipe installs a pinned wheel with `pip` through a Python interpreter the user names explicitly. The global layer accepts one optional key:

| Key | Default | Meaning |
|-|-|-|
| `pythonInterpreter` | unset | Absolute path of the trusted Python used only to install Python recipes. |

The value is global-only: a project file that sets it is rejected as invalid. The path must be absolute, without shell syntax, quotes or `..` segments. An empty or missing value is the manual fallback: the extension installs nothing and reports what to configure. It never resolves `python` from `PATH` and never uses a project virtual environment or the `py` launcher. The key is inert until a Python recipe is admitted; `ty` and `ruff` stay `candidate` and their manual routes keep working.
