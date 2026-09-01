# Contributing

`pi-lsp-manager` has a published `0.2.0` release and accepts focused issues, documentation changes, and pull requests. Discuss new installation recipes, configuration keys, tools, supported platforms, and trust behavior before implementation so the public contract and security boundary are clear.

## Report a problem

Use the [issue chooser](https://github.com/Yivas/pi-lsp-manager/issues/new/choose) after searching existing issues. Include the commit or published version, Pi/Node.js/operating-system versions, the affected file type and language server, and the smallest sanitized reproduction with expected and observed behavior.

Remove credentials, tokens, prompts, file contents, private paths, identifiers, environment values, and active configuration. Report undisclosed vulnerabilities only through [SECURITY.md](SECURITY.md), not a public issue.

## Propose a change

Use the [feature request form](https://github.com/Yivas/pi-lsp-manager/issues/new?template=feature_request.yml) before proposing installation recipes, configuration keys, tools, platforms, or trust behavior. Explain the user problem, observable contract, alternatives, privacy impact, and security consequences.

A pull request should stay within an accepted scope, include applicable evidence, update affected documentation, and avoid unrelated formatting or refactoring. New installation or process-execution behavior requires negative tests for disabled policy, untrusted configuration, failure, cancellation, and concurrency.

## Validation

Install the locked dependencies with `npm ci`, then run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run pack:check
```

Changes to pinned real-server behavior must also run the applicable fixture, for example:

```bash
RUN_REAL_LSP=1 npm test -- test/real-servers/typescript-language-server.test.ts
```

Document the exact server, language, Pi, Node.js, operating-system, and architecture versions for any compatibility claim. Do not describe a catalog candidate or detected executable as supported without a passing real fixture and an exact compatibility row.

## License and conduct

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE). All interactions follow the [Code of Conduct](CODE_OF_CONDUCT.md).
