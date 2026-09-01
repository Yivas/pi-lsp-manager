# Security model

Language servers are local programs with the same operating-system permissions as Pi. They can read project files and may execute language-specific tooling. `pi-lsp-manager` narrows when those programs can be installed, started, and allowed to mutate files; it does not sandbox them.

## Trust boundary

For an untrusted project, the extension does not:

- read project configuration;
- resolve or start language servers;
- run LSP tools, post-edit diagnostics, or warmup;
- accept executable settings from project files.

Global configuration can define manual routes, but it is not a project-provided command source. A trusted project's configuration remains reduction-only: it can disable known servers or installation, lower priorities and diagnostic timings, add exclusions, or force `offline`; it cannot add or change a route. The extension does not automatically import `pi-lsp.json`, `lsp.json`, editor settings, or another extension's configuration.

The only untrusted-project exception is an explicit `/lsp install <id>` request. That command may install a built-in server without reading project files or starting the server. It still enforces global enabled state, catalog admission, platform support, network policy, recipe integrity, and the installation lock.

## Installation boundary

Automatic installation can begin only from an authorized LSP operation or post-edit diagnostic. Browsing, searching, reading, discovering files, indexing, status checks, and warmup do not install software. `/lsp warmup <id>` starts only an already available server.

Recipes are compiled into the extension. Projects cannot provide package names, versions, registries, URLs, commands, arguments, environment variables, integrity values, or lifecycle scripts. npm runs with:

- a generated exact lockfile;
- `npm ci`;
- lifecycle scripts disabled;
- isolated cache, home, prefix, and staging directories;
- a minimal environment;
- integrity and executable verification before promotion.

A per-server lock serializes installers. Cancellation before promotion leaves no managed state; cancellation during atomic promotion completes the current safe boundary and reports the outcome.

## Manual route and process boundary

Global manual routes use an executable and argv array, never a shell string. The process starts with the canonical workspace root as its working directory. Only a small host environment is inherited (`PATH`, platform system paths, home and temporary-directory variables); route-specific `env` values are added from global configuration. Review these values before enabling a route.

Servers start only after trust and selection checks. Executable resolution rejects shell indirection, path escapes, unexpected symlinks, and writable managed artifacts. The runtime uses framed JSON-RPC, request deadlines, cancellation, bounded stderr capture, process reuse, idle reaping, and explicit shutdown.

No telemetry or analytics are collected.

## Discovery and diagnostics boundary

Batch discovery is canonical and bounded. It does not follow symlinked files, directories, or cycles; rejects paths outside the workspace; applies built-in and configured directory exclusions; and bounds explicit paths, filesystem entries, accepted files, and document size. Discovery itself never installs or starts a server.

## Mutation boundary

Read tools cannot edit files. Rename and code-action application require a preview tied to the current session, server, canonical file, and content hash. Before commit, the extension validates every text edit, path, authority, version, overlap, aggregate limit, symlink boundary, and file snapshot.

Multi-file commits use canonical lock ordering, exclusive temporary files and backups, atomic replacement, and rollback. A failed rollback preserves recovery artifacts and reports only relative names, never file contents or private absolute paths.

Resource operations such as create, rename, and delete are rejected.

## Logs and audit

User-facing errors are stable codes with short recovery guidance. Output is bounded and sanitized. It must not contain:

- source-file content;
- environment values or credentials;
- auth-bearing URLs;
- package-manager dumps;
- private absolute paths.

The private installation audit records decisions and integrity metadata, not secrets or project content. `lsp_status` exposes state such as availability and admission, not command argv, route environment, PATH, or private paths.

## Reporting a vulnerability

Follow [SECURITY.md](../SECURITY.md). Do not include credentials, private source code, or sensitive paths in a public issue.
