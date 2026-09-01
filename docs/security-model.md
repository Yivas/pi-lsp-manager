# Security model

Language servers are local programs with the same operating-system permissions as Pi. They can read project files and may execute language-specific tooling. `pi-lsp-manager` narrows when those programs can be installed, started, and allowed to mutate files; it does not sandbox them.

## Trust boundary

For an untrusted project, the extension does not:

- read project configuration;
- resolve or start language servers;
- run LSP tools, post-edit diagnostics, or warmup;
- accept executable settings from project files.

The only exception is an explicit `/lsp install <id>` request. That command may install a built-in server without reading project files or starting the server. It still enforces the global enabled state, catalog admission, platform support, network policy, recipe integrity, and installation lock.

## Installation boundary

Automatic installation can begin only from an authorized LSP operation or post-edit diagnostic. Browsing, searching, reading, extension detection, indexing, status checks, and warmup do not install software.

Recipes are compiled into the extension. Projects cannot provide package names, versions, registries, URLs, commands, arguments, environment variables, integrity values, or lifecycle scripts. npm runs with:

- a generated exact lockfile;
- `npm ci`;
- lifecycle scripts disabled;
- isolated cache, home, prefix, and staging directories;
- a minimal environment;
- integrity and executable verification before promotion.

A per-server lock serializes installers. Cancellation before promotion leaves no managed state; cancellation during an atomic promotion completes the current safe boundary and then reports the outcome.

## Process boundary

Servers start only after trust and selection checks. Executable resolution rejects shell indirection, path escapes, unexpected symlinks, and writable managed artifacts. The runtime uses framed JSON-RPC, request deadlines, cancellation, bounded stderr capture, process reuse, idle reaping, and explicit shutdown.

No telemetry or analytics are collected.

## Mutation boundary

Read tools cannot edit files. Rename and code-action application require a preview tied to the current session, server, canonical file, and content hash. Before commit, the extension validates every text edit, path, authority, version, overlap, aggregate limit, symlink boundary, and file snapshot.

Multi-file commits use canonical lock ordering, exclusive temporary files and backups, atomic replacement, and rollback. A failed rollback preserves recovery artifacts and reports only relative names, never file contents or private absolute paths.

Resource operations such as create, rename, and delete are rejected in v1.

## Logs and audit

User-facing errors are stable codes with short recovery guidance. Output is bounded and sanitized. It must not contain:

- source-file content;
- environment values or credentials;
- auth-bearing URLs;
- package-manager dumps;
- private absolute paths.

The private installation audit records decisions and integrity metadata, not secrets or project content.

## Reporting a vulnerability

Follow [SECURITY.md](../SECURITY.md). Do not include credentials, private source code, or sensitive paths in a public issue.
