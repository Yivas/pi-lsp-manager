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

- an exact generated lockfile for direct-only recipes, or an extension-owned lockfile with the complete pinned dependency tree for Vue;
- `npm ci`;
- lifecycle scripts disabled;
- isolated cache, home, prefix, and staging directories;
- a minimal environment;
- integrity and executable verification before promotion.

A per-server lock serializes installers. Cancellation before promotion normally leaves no managed state, but a cleanup that cannot guarantee removal keeps the affected state and reports a bounded residual in the audit record instead of hiding it: when the package-manager process cannot be confirmed stopped, the coordinator keeps its own partial staging directory and the per-server lock, so no retry overlaps that process (`termination_unconfirmed`); when termination is confirmed but removing that directory still fails after its bounded retries, it keeps the directory and releases the lock (`staging_cleanup_failed`); and when releasing the lock itself times out or fails, it reports `lock_release_failed` because the lock may still be held. Cancellation during atomic promotion completes the current safe boundary and reports the outcome.

## Manual route and process boundary

Global manual routes use an executable and argv array, never a shell string. The process starts with the canonical workspace root as its working directory. Only a small host environment is inherited (`PATH`, platform system paths, home and temporary-directory variables); route-specific `env` values are added from global configuration. Review these values before enabling a route.

Servers start only after trust and selection checks. Executable resolution rejects shell indirection, path escapes, and writable managed artifacts; on Unix it follows a command link to its regular executable target, and the managed verifier still requires the resolved target to stay inside the installation root. The runtime uses framed JSON-RPC, request deadlines, cancellation, bounded stderr capture, process reuse, idle reaping, and explicit shutdown.

The Vue 3.3.11 route, whether configured manually or installed by its admitted recipe, also starts one TypeScript `tsserver` per Vue session. It requires the matching Vue plugin and TypeScript SDK in the same verified npm root before either process starts. The bridge forwards `_vue:` plugin requests with bounded responses and checks a file argument before opening it, rejecting files outside the workspace. The tsserver child receives a reduced host environment, not project-supplied process settings. Invalid request framing, a failed plugin response, timeout, or caller cancellation terminates both processes and evicts the session instead of returning an incomplete semantic result. The plugin has Pi's filesystem privileges; this bridge is not a sandbox.

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

## Development dependency audit

CI runs `npm run audit:check`, which executes the full `npm audit --json --audit-level=low` over the locked tree, validates the report, and fails closed on unreadable, malformed, or unfamiliar output. It accepts exactly one finding: the development-only `brace-expansion@5.0.9` nested under the pinned, development-only `@earendil-works/pi-coding-agent@0.87.1`, whose published `npm-shrinkwrap.json` forces that version.

The accepted advisories are `GHSA-q2hr-2g5m-vwhr`, `GHSA-qhr7-859c-m2p7`, and `GHSA-6j4f-fj2g-mc7p`. The exception holds only while the lockfile entry, the installed manifests, and the nested shrinkwrap agree on the exact package, version, parent, and integrity; any other package, path, version, advisory, or production finding fails the gate. The gate forces the development tree into the audit (`--include=dev`), so an `omit=dev`, `NODE_ENV=production`, or `production=true` npm configuration cannot hide it and return a false clean result. It does not hide the installed version or claim a fix: the development tree still installs the vulnerable version, and that version never reaches the published package or its consumers, because the package ships no lockfile and its only runtime dependency is `vscode-jsonrpc`.

`npm run audit:full` runs the same audit without the exception. The exception is temporary and tracked in the upstream issues [#5653](https://github.com/earendil-works/pi/issues/5653) (open, move off the shipped shrinkwrap) and [#7628](https://github.com/earendil-works/pi/issues/7628) (closed as no-action, about the 0.83.0 shrinkwrap pins). Remove the exception when an upstream Pi release installs `brace-expansion` 5.0.12 or newer in both the lockfile and the installed tree. A clean report is only taken as a stale exception when the pinned version is really gone from the lock, the installed tree, and the shrinkwrap; a clean report while it is still installed is rejected as contradictory instead of passing silently. The gate also cross-checks the installed hidden lock when it exists, but that check is optional: the lock, the installed manifests, and the shrinkwrap already cover the same facts.

## Reporting a vulnerability

Follow [SECURITY.md](../SECURITY.md). Do not include credentials, private source code, or sensitive paths in a public issue.
