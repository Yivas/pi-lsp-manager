# pi-lsp-manager

`pi-lsp-manager` is a [Pi](https://pi.dev) extension that resolves, installs, and reuses language servers only when an LSP operation needs them.

It adds diagnostics, navigation, symbols, guarded rename, and guarded code-action application without replacing the formatter, linter, type checker, test suite, or CI owned by the repository.

## Status

Version `0.1.0` is the first supported release line. The v1 catalog contains TypeScript Language Server `5.3.0` with TypeScript `5.9.3`. Compatibility claims are limited to the exact rows in [Language servers](docs/servers.md).

## How it works

1. An LSP tool receives a concrete file in a trusted project.
2. The extension resolves the project root and selects the highest-priority compatible server for the requested role.
3. An installed server starts, or the session reuses an existing healthy process.
4. An authorized operation may install a missing server once through a fixed, integrity-checked recipe.
5. Read results are bounded and sanitized. Mutations require a fresh preview and revalidate every affected file before commit.

Browsing, searching, reading, indexing, status checks, extension detection, and warmup never install software.

## Install

Install the exact release from npm:

```bash
pi install npm:pi-lsp-manager@0.1.0
```

Pi packages execute with full user permissions. Review the source and [security model](docs/security-model.md) before installation.

To remove the package:

```bash
pi remove npm:pi-lsp-manager
```

## Tools

| Tool | Purpose |
|-|-|
| `lsp_diagnostics` | Return current diagnostics for one file. |
| `lsp_definition` | Find definitions at a UTF-16 position. |
| `lsp_references` | Find references with bounded output. |
| `lsp_symbols` | List document symbols. |
| `lsp_prepare_rename` | Validate and preview a rename target. |
| `lsp_rename` | Apply the previewed rename as a validated workspace edit. |
| `lsp_code_actions` | Preview code actions for a range. |
| `lsp_apply_code_action` | Resolve and apply one stored preview. |
| `lsp_status` | Show policy, selection, installation, and runtime state. |

Mutation tools reject stale previews, changed files, path escapes, resource operations, overlapping edits, oversized edit sets, and unsupported document versions. Multi-file commits use ordered queues, atomic replacement, and rollback.

## Commands

- `/lsp status` — show the current server and runtime state;
- `/lsp policy` — show effective trust, network, and installation policy;
- `/lsp install typescript` — explicitly install the built-in TypeScript recipe without starting it;
- `/lsp warmup` — start an already installed server for a trusted project; never installs;
- `/lsp audit` — show sanitized installation decisions.

## Configuration

No configuration is required. Automatic installation and post-edit diagnostics are enabled by default and may be reduced globally or by a trusted project.

See [Configuration](docs/configuration.md) for file locations, merge rules, defaults, and the offline policy.

## Security and privacy

Projects cannot provide executable commands, packages, URLs, registries, integrity values, or installation recipes. Untrusted projects cannot configure, start, warm, or invoke a server. An explicit `/lsp install <id>` is the narrow exception: it may install only a built-in recipe under global policy, without reading project files or starting the server.

The extension collects no telemetry or analytics. Errors, status, and audit output are bounded and must not expose source content, credentials, environment values, or private absolute paths.

Read the full [security model](docs/security-model.md). Report undisclosed vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

## Troubleshooting

See [Troubleshooting](docs/troubleshooting.md) for trust failures, offline installation, diagnostic timeouts, runtime failures, rejected mutations, and safe bug-report evidence.

## Contributing

Focused issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing behavior, and use the feature request form for new capabilities. All interactions follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Licensed under the [MIT License](LICENSE).
