# Security Policy

## Supported versions

| Version or line | Support status |
|-|-|
| `0.2.x` | Supported |
| `0.1.x` | Unsupported |
| Development `main` | Security fixes target the latest commit on a best-effort basis |

The supported line is tested only against the exact host and TypeScript rows in [Language servers](docs/servers.md). Those rows are compatibility evidence, not a promise to support every release of the listed operating systems.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Yivas/pi-lsp-manager/security/advisories/new). Do not open a public issue for an undisclosed vulnerability.

Include:

- the affected commit or version;
- the Pi, Node.js, and operating-system versions;
- the affected language server or installation recipe;
- the smallest sanitized reproduction;
- expected and observed behavior;
- impact and any known workaround.

Remove credentials, tokens, prompts, file contents, private paths, identifiers, and active configuration values.

## Security boundary

`pi-lsp-manager` coordinates language-server processes and may invoke allowlisted package-manager recipes. It is not an operating-system sandbox. A language server runs with the same operating-system permissions as Pi and may read project files or invoke language tooling.

A valid report may involve command selection, project trust, path resolution, recipe or architecture admission, concurrent installation, cancellation, process lifecycle, workspace-edit validation, rollback, output sanitization, or unintended network and filesystem access. Resource operations such as file creation, rename, and deletion are rejected in v1 rather than sandboxed.

See the [security model](docs/security-model.md) for the documented trust, installation, process, mutation, logging, and audit boundaries.

The maintainer will review the private report, reproduce it when possible, and coordinate a fix and disclosure through the advisory. Do not disclose the vulnerability before that coordination is complete.
