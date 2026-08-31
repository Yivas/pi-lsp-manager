# pi-lsp-manager

`pi-lsp-manager` is a planned [Pi](https://pi.dev) extension for resolving, installing, and running language servers only when an LSP operation needs them.

## Status

The project is in design. There is no installable package, supported release, stable configuration contract, or user support during this phase. Design documentation and focused contributions are welcome, but they do not create a support commitment.

## Project mode

This is an open source collaborative project licensed under MIT. It accepts focused issues and pull requests under the contribution boundaries below. Undisclosed vulnerabilities must use the private reporting channel in [SECURITY.md](SECURITY.md).

## Intended behavior

1. An LSP tool receives a concrete file.
2. The extension resolves the compatible server with the highest configured priority.
3. An installed server starts or reuses its shared process.
4. A missing server may be installed once through an allowlisted recipe.
5. Unsupported or disabled installations return manual instructions without changing the machine.

Scanning, indexing, reading files, or discovering an extension will not install software. Project configuration is a trust boundary: it never supplies executable commands, packages, URLs, or recipes.

## Planned capabilities

- Diagnostics, definitions, references, symbols, and safe rename operations.
- Lazy server startup with shared clients and idle cleanup.
- Policy-controlled installation with per-server locks and cancellation.
- Global and trusted-project configuration with explicit trust boundaries.
- Windows, macOS, and Ubuntu LTS support only when backed by platform tests.
- Sanitized failures without file contents, credentials, or private paths.

Repository-native formatters, linters, type checkers, tests, and CI remain authoritative.

## Security model

Automatic installation will accept only recipes distributed with the extension. LSP tools, post-edit diagnostics, and warmup will require a trusted project. Untrusted project configuration is ignored and cannot start a server or trigger automatic installation. An explicit `/lsp install <id>` may install from an untrusted project, but it uses only the built-in catalog and global policy, reads no project file, and does not start the server. Users will be able to disable automatic installation globally or for individual servers. Do not report undisclosed vulnerabilities in a public issue; follow the [security policy](SECURITY.md).

## Contributing

The project accepts focused documentation and design contributions now, and will review focused implementation proposals as contracts become defined. Use the [feature request form](https://github.com/Yivas/pi-lsp-manager/issues/new?template=feature_request.yml) before proposing new behavior, then read [CONTRIBUTING.md](CONTRIBUTING.md). All interactions follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Licensed under the [MIT License](LICENSE).
