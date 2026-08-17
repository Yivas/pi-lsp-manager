# pi-lsp-manager

`pi-lsp-manager` is a planned Pi extension for resolving, installing, and running language servers only when an LSP operation needs them.

## Status

The project is in design. There is no installable package, supported release, or stable configuration contract yet.

## Intended behavior

1. An LSP tool receives a concrete file.
2. The extension resolves the compatible server with the highest configured priority.
3. An installed server starts or reuses its shared process.
4. A missing server may be installed once through an allowlisted recipe.
5. Unsupported or disabled installations return manual instructions without changing the machine.

Scanning a repository, indexing files, or discovering an extension will not install software.

## Planned capabilities

- Diagnostics, definitions, references, symbols, and safe rename operations.
- Lazy server startup with shared clients and idle cleanup.
- Policy-controlled installation with per-server locks and cancellation.
- Global and project configuration with explicit trust boundaries.
- Windows, macOS, and Linux support backed by platform tests.
- Sanitized failures without file contents, credentials, or private paths.

Repository-native formatters, linters, type checkers, tests, and CI remain authoritative.

## Security model

Automatic installation will accept only recipes distributed with the extension. Project configuration will not supply executable installation commands by default. Users will be able to disable automatic installation globally or for individual servers.

Do not report undisclosed vulnerabilities in a public issue. Follow the [security policy](SECURITY.md).

## Contributing

The project accepts focused issues and pull requests. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing behavior or code. All interactions follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Licensed under the [MIT License](LICENSE).
