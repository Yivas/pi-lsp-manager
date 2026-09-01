# Changelog

## Unreleased

## 0.2.0 - 2026-09-01

### Added

- Complete global manual server routes with executable argv, optional environment and LSP initialization options, extensions, language IDs, extension-specific language-ID mapping, roles, priority, and diagnostic timing.
- Manual catalog entries for Biome, Tailwind CSS, ESLint, Python, Rust, Go, Ruby, Elixir, Zig, C#, F#, Swift, C/C++, Java, Kotlin, YAML, Lua, PHP, Prisma, Dart, OCaml, Bash, Terraform, TeX, Gleam, Clojure, Nix, Typst, and Haskell, with explicit candidate admission rather than compatibility claims.
- Batch `lsp_diagnostics` inputs for `paths`, `servers`, `fileLimit`, `limit`, and `severity`, with deterministic canonical discovery, default and configured directory exclusions, bounded output, omissions, and partial failures. The legacy `filePath` form remains available.
- `lsp_fix` source-action previews and optional single-action writes, including `source.fixAll` and `source.organizeImports`; ambiguous results can be selected with `lsp_apply_code_action`.
- Expanded `lsp_status` records for route configuration, availability, runnable state, admission, roles, extensions, recipe presence, installability, and runtime activity, plus the generic `LSP working` UI activity status.

### Changed

- Trusted-project configuration remains reduction-only: it can disable or reduce known global routes and policy, but cannot add commands, arguments, environment, initialization, extensions, language IDs, roles, or recipes.
- Configuration no longer treats another extension's server file as an import source. Manual migration requires reviewing and transcribing a complete global route.
- Server selection now uses catalog and global route metadata, role coverage, language IDs, and deterministic priority ordering. Diagnostic auxiliaries run only when already available; only the selected primary can use an authorized installation path.
- Diagnostic discovery and execution reuse one session per canonical workspace-root/server pair, do not follow symlinks, and preserve bounded cancellation and shutdown behavior.

### Fixed

- Prevented discovery and status paths from creating installation state, locks, staging directories, audit records, or server processes as side effects.
- Prevented `lsp_fix` from writing when no source action or multiple source actions are returned; every selected action continues through preview hashing and validated workspace-edit checks.
- Kept untrusted-project operations fail-closed before project configuration reads, path reads, discovery, process startup, or installation. The explicit `/lsp install <id>` exception remains global-policy-only and does not start a server.

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
