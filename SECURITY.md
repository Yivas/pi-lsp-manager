# Security Policy

## Supported versions

| Version or line | Support status |
|-|-|
| Development `main` | Security fixes target the latest commit on a best-effort basis |
| Published releases | None exist yet |

The table will list maintained release lines after the first publication.

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

`pi-lsp-manager` coordinates language-server processes and may invoke allowlisted package-manager recipes. It is not an operating-system sandbox. A valid report may involve command selection, project trust, path resolution, concurrent installation, cancellation, output sanitization, or unintended network and filesystem access.

The maintainer will review the private report, reproduce it when possible, and coordinate a fix and disclosure through the advisory. Do not disclose the vulnerability before that coordination is complete.
