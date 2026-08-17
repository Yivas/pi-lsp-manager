# Contributing

`pi-lsp-manager` accepts focused issues and pull requests. The project is still defining its first public contracts, so discuss broad architecture changes before writing them.

## Report a problem

Search existing issues first. A useful report includes:

- the commit or published version, when one exists;
- the Pi, Node.js, and operating-system versions;
- the affected file type and language server;
- the smallest sanitized reproduction;
- expected and observed behavior.

Remove credentials, tokens, prompts, file contents, private paths, identifiers, and active configuration values. Report undisclosed vulnerabilities through the private channel in [SECURITY.md](SECURITY.md).

## Propose a change

Open a feature request before changes that add installation recipes, configuration keys, tools, platforms, or trust behavior. Explain the user problem, proposed contract, alternatives, and security consequences.

A pull request should stay within the accepted scope, include tests, update affected documentation, and avoid unrelated formatting or refactoring. New installation behavior requires negative tests for disabled policy, untrusted configuration, failure, cancellation, and concurrency.

## Validation

The repository will document authoritative commands in `package.json` when implementation begins. Until then, documentation changes must have valid links, accurate status, and no unsupported installation instructions.

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE). All interactions follow the [Code of Conduct](CODE_OF_CONDUCT.md).
