# Security Policy

## Supported versions

The project has no published release yet. Security fixes currently target the latest commit on the default branch. This statement will be replaced by a version table before the first release.

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
