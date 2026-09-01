# Configuration

`pi-lsp-manager` works without a configuration file. The built-in defaults enable TypeScript Language Server, automatic installation, post-edit diagnostics, and network access for the fixed installation recipe.

## File locations

The global file is `pi-lsp-manager.json` in Pi's agent directory, as returned by `getAgentDir()`. Managed language servers and the private installation audit live under `lsp-manager` in the same directory.

A trusted project may add `.pi/pi-lsp-manager.json` at its workspace root. The project file is never read before Pi reports that the project is trusted.

## Example

```json
{
  "version": 1,
  "network": "auto",
  "autoInstall": true,
  "postEditDiagnostics": true,
  "servers": {
    "typescript": {
      "enabled": true,
      "autoInstall": true,
      "priority": 100
    }
  }
}
```

Unknown keys, invalid types, and malformed JSON invalidate that entire layer instead of being ignored.

## Merge and trust rules

Configuration is merged in this order:

1. built-in defaults;
2. global configuration;
3. trusted-project configuration.

A project may only reduce privileges for a known server. It can set `enabled`, `autoInstall`, or `postEditDiagnostics` to `false`, set `network` to `offline`, and lower a server priority. It cannot add commands, arguments, environment variables, packages, URLs, initialization options, extensions, language IDs, or recipes.

`false` and `offline` are sticky: a later layer cannot turn them back on.

## Network policy

- `auto` permits the built-in, version-pinned npm recipe when every other policy check passes. It does not probe the network first.
- `offline` prevents installation before a package-manager process, lock, staging directory, or audit record is created.

Standard proxy environment variables may be inherited by npm but are never written to logs or audit records.

## Server settings

Global server entries may configure these keys for a built-in ID:

- `enabled`: whether the server may be selected;
- `autoInstall`: whether an authorized LSP operation may install it;
- `priority`: selection priority;
- `command`, `args`, and `env`: global-only executable settings;
- `extensions`, `languageIds`, and `roles`: global-only routing settings;
- `initialization`: global-only LSP initialization options.

Project configuration cannot set the executable-facing keys.

## Defaults

| Setting | Default |
|-|-|
| `network` | `auto` |
| `autoInstall` | `true` |
| `postEditDiagnostics` | `true` |
| `typescript.enabled` | `true` |
| `typescript.autoInstall` | `true` |
| `typescript.priority` | `100` |

Restart or reload the Pi session after changing global executable settings. Use `/lsp policy` and `lsp_status` to inspect the effective policy without exposing private paths.
