---
title: Security and privacy
description: Review trust, installation, process, mutation, privacy, and vulnerability-reporting boundaries.
---

Language servers are local programs with Pi's operating-system permissions. They can read project files and may invoke language tooling. `pi-lsp-manager` controls installation, startup, and mutation conditions; it is not an operating-system sandbox.

## Trust and installation

Untrusted projects cannot provide project configuration, resolve or start routes, use file-based LSP tools, warm up servers, or run post-edit diagnostics. `lsp_status` may return sanitized global state without reading project configuration or starting a server. The only state-changing exception is explicit `/lsp install <id>` for an allowed built-in recipe; it does not read project files or start a server.

Projects cannot set package names, versions, registries, integrity values, URLs, commands, argv, environment values, or recipes. Built-in installation uses an exact generated lockfile, `npm ci`, disabled lifecycle scripts, isolated cache/home/prefix/staging directories, integrity checks, executable verification, and a per-server lock.

## Processes, discovery, and edits

Manual routes are global, executable-plus-argv definitions; the extension does not invoke a shell. It rejects shell indirection, path escapes, unexpected symlinks, and writable managed artifacts. Discovery canonicalizes paths, does not follow symlinks, and bounds traversal and file size.

Rename and source-action writes require a current preview tied to the session, server, file, and content hash. Before commit, every edit is checked for path, authority, version, overlap, limits, symlink boundaries, and changed snapshots. Resource operations that create, rename, or delete files are rejected.

## Privacy

The extension collects no telemetry or analytics. User-facing output and audit records are bounded and sanitized. They must not expose source content, credentials, environment values, auth-bearing URLs, package-manager dumps, or private absolute paths.

Report an undisclosed vulnerability through [GitHub private vulnerability reporting](https://github.com/Yivas/pi-lsp-manager/security/advisories/new), not a public issue. Include a sanitized reproduction and remove credentials, source content, private paths, and active configuration values.

## Canonical source

[Security model](https://github.com/Yivas/pi-lsp-manager/blob/main/docs/security-model.md)
