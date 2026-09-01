# pi-lsp-manager

`pi-lsp-manager` is a [Pi](https://pi.dev) extension that resolves and reuses language servers when an LSP operation needs them. It can install only fixed, integrity-checked recipes; global configuration can also define reviewed manual routes.

It adds diagnostics, navigation, symbols, guarded rename, and guarded code-action application without replacing the formatter, linter, type checker, test suite, or CI owned by the repository.

## Status

Version `0.2.0` adds the manual catalog, complete global routes, batch diagnostics, source-fix workflow, and expanded status fields. TypeScript Language Server `5.3.0` with TypeScript `5.9.3` remains the only auto-installable and platform-tested route; compatibility claims are limited to the exact rows in [Language servers](docs/servers.md).

## How it works

1. An LSP tool receives a concrete file in a trusted project.
2. The extension resolves the canonical project root and selects the highest-priority compatible server for the requested role.
3. An available server starts, or the session reuses an existing healthy process.
4. An authorized operation may install a missing built-in server once through a fixed recipe.
5. Read results are bounded and sanitized. Mutations require a fresh preview and revalidate every affected file before commit.

A trusted project's configuration can only reduce the effective policy. An untrusted project is not read or started by LSP operations. Browsing, searching, reading, discovery, indexing, status checks, and warmup never install software.

## Quickstart

Install the published release:

```bash
pi install npm:pi-lsp-manager@0.2.0
```

Pi packages execute with full user permissions. Review the source and [security model](docs/security-model.md) before installation.

After Pi trusts the project, call an LSP tool with a workspace-relative file. For example:

```text
lsp_diagnostics({"filePath":"src/index.ts"})
```

The legacy `filePath` form returns diagnostics for one file. The batch form can scan the trusted workspace or selected paths:

```text
lsp_diagnostics({"paths":["src","test"],"fileLimit":100,"limit":100})
```

To remove the published package:

```bash
pi remove npm:pi-lsp-manager
```

## Tools

| Tool | Purpose |
|-|-|
| `lsp_diagnostics` | Read diagnostics for one file with legacy `filePath`, or scan `paths`/the workspace with selected `servers`, `fileLimit`, `limit`, and `severity`. |
| `lsp_definition` | Find definitions at a UTF-16 position. |
| `lsp_references` | Find references at a UTF-16 position. |
| `lsp_symbols` | List document or workspace symbols. |
| `lsp_prepare_rename` | Validate and preview a rename target. |
| `lsp_rename` | Apply the previewed rename as a validated workspace edit. |
| `lsp_code_actions` | Preview code actions for a file and optional kind; it never writes. |
| `lsp_fix` | Preview source actions, or apply one unambiguous action when `write: true`. Defaults to `kind: "source.fixAll"` and `write: false`. |
| `lsp_apply_code_action` | Resolve and apply one stored `lsp_code_actions` or `lsp_fix` preview when it is still current. |
| `lsp_status` | Show trust, policy, admission, route, installation, and runtime state without private paths or route environment values. |

`lsp_fix` supports source kinds such as `source.fixAll` and `source.organizeImports`. `write: true` writes only when exactly one action is available; zero or multiple actions return previews for selection with `lsp_apply_code_action`. All mutation tools reject stale previews, changed files, path escapes, resource operations, overlapping edits, oversized edit sets, and unsupported document versions. Multi-file commits use ordered queues, atomic replacement, and rollback reporting.

Batch diagnostics are deterministic and bounded. Discovery canonicalizes paths, does not follow symlinks, excludes common dependency/build/cache/environment directories, and reports omissions and partial server failures without hiding successful results. See [Troubleshooting](docs/troubleshooting.md) for limits and result fields.

## Commands

- `/lsp status` — show sanitized server and runtime state;
- `/lsp policy` — show effective trust, network, and installation policy;
- `/lsp install <id>` — explicitly install a built-in recipe without starting it;
- `/lsp warmup <id>` — start an already installed and available server for a trusted project; never installs;
- `/lsp audit` — show sanitized installation decisions.

The generic Pi activity status `LSP working` appears while an LSP tool or `/lsp` operation is active in a UI context and clears when all work ends.

## Configuration

No configuration is required. Automatic installation and post-edit diagnostics are enabled by default and may be reduced globally or by a trusted project.

Global configuration can define a complete manual route with an executable, argv, optional environment and initialization options, extensions, language IDs, roles, priority, and diagnostic timing. A trusted project cannot add or change those values, and the extension does not import another extension's configuration automatically. See [Configuration](docs/configuration.md) for the schema, exclusions, merge rules, and a reviewed migration example.

## Security and privacy

Projects cannot provide executable commands, packages, URLs, registries, integrity values, or installation recipes. Untrusted projects cannot configure, start, warm, or invoke a server. An explicit `/lsp install <id>` is the narrow exception: it may install only a built-in recipe under global policy, without reading project files or starting the server.

The extension collects no telemetry or analytics. Errors, status, and audit output are bounded and must not expose source content, credentials, environment values, auth-bearing URLs, or private absolute paths. Language servers run with Pi's operating-system permissions; this extension is not a sandbox.

Read the full [security model](docs/security-model.md). Report undisclosed vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Troubleshooting

See [Troubleshooting](docs/troubleshooting.md) for stable error codes, trust failures, offline or unavailable installation, diagnostic timeouts, batch omissions, runtime failures, source-action ambiguity, and safe bug-report evidence.

## Contributing

Focused issues and pull requests are welcome. Read the [contribution guide](https://github.com/Yivas/pi-lsp-manager/blob/main/CONTRIBUTING.md) before changing behavior, and use the feature request form for new capabilities. All interactions follow the [Code of Conduct](https://github.com/Yivas/pi-lsp-manager/blob/main/CODE_OF_CONDUCT.md).

## License

Licensed under the [MIT License](LICENSE).
