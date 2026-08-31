# Contributing

`pi-lsp-manager` is in design. The project accepts documentation and design contributions now, and focused implementation contributions once their public contract has been discussed. There is no supported package or user-support commitment yet.

## Report a problem

Use the [issue chooser](https://github.com/Yivas/pi-lsp-manager/issues/new/choose) after searching existing issues. A useful report includes the commit or published version when one exists, Pi/Node.js/operating-system versions, the affected file type and language server, and the smallest sanitized reproduction with expected and observed behavior. Documentation and design reports may mark runtime-only fields `N/A` with a short reason.

Remove credentials, tokens, prompts, file contents, private paths, identifiers, and active configuration values. Report undisclosed vulnerabilities only through [SECURITY.md](SECURITY.md), not a public issue.

## Propose a change

Use the [feature request form](https://github.com/Yivas/pi-lsp-manager/issues/new?template=feature_request.yml) before proposing installation recipes, configuration keys, tools, platforms, or trust behavior. Explain the user problem, observable contract, alternatives, privacy impact, and security consequences.

A pull request should stay within an accepted scope, include applicable evidence, update affected documentation, and avoid unrelated formatting or refactoring. Documentation and design pull requests may mark a validation item `N/A` with a short reason. New installation behavior requires negative tests for disabled policy, untrusted configuration, failure, cancellation, and concurrency.

## Validation

The repository will document authoritative commands in `package.json` when implementation begins. Until then, documentation and design changes must have valid links, accurate status, and no unsupported installation instructions.

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE). All interactions follow the [Code of Conduct](CODE_OF_CONDUCT.md).
