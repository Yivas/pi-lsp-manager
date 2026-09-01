# Changelog

## 0.1.0 - 2026-09-01

First public release.

### Added

- TypeScript and JavaScript diagnostics, definitions, references, document and workspace symbols, rename preparation, and code-action previews.
- Guarded rename and code-action application with canonical path checks, content-bound previews, validated textual `WorkspaceEdit` operations, ordered mutation queues, atomic replacement, rollback, and recovery reporting.
- Lazy TypeScript Language Server startup, process reuse, request cancellation, bounded diagnostics, one retry for transient read failures, idle cleanup, and session shutdown.
- Policy-controlled installation of TypeScript Language Server 5.3.0 and TypeScript 5.9.3 through an exact internal npm recipe with integrity checks, isolated staging, per-server locks, post-install verification, cancellation, and sanitized audit records.
- Global and trusted-project configuration with sticky restrictions for trust, network access, automatic installation, server enablement, and post-edit diagnostics.
- `/lsp` status, policy, install, warmup, and audit commands.
- Public configuration, server compatibility, security-model, and troubleshooting documentation.
- Pinned CI coverage on Windows Server 2022 x64, macOS 14 arm64, and Ubuntu 24.04 x64 with Node 22.19.0 and Pi 0.84.1.

### Security

- Untrusted projects cannot configure, start, warm, or invoke language servers.
- Projects cannot provide installation recipes, packages, registries, URLs, commands, arguments, environment variables, or integrity values.
- User-facing output excludes source content, credentials, environment values, and private absolute paths.

### Limits

- The v1 catalog supports only TypeScript and JavaScript through TypeScript Language Server.
- Workspace resource operations such as file creation, rename, and deletion are rejected.
- Language servers run with Pi's operating-system permissions; this extension is not a sandbox.
