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
npm run audit:check
npm run pack:check
```

`npm run audit:check` runs the full `npm audit --json` over the locked tree and fails on any finding except the single development-only exception documented in the [security model](docs/security-model.md). `npm run audit:full` runs the same audit without that exception when you want the raw result.

Changes to pinned real-server behavior must also run the applicable fixture, for example:

```bash
RUN_REAL_LSP=1 npm test -- test/real-servers/typescript-language-server.test.ts
RUN_REAL_VUE=1 npm test -- test/real-servers/vue-language-server.test.ts
RUN_REAL_TAILWIND=1 TAILWIND_CLI=<absolute-server-path> npm test -- test/real-servers/tailwindcss.test.ts
```

For the Vue fixture, `VUE_CLI` may point to the absolute `vue-language-server.js` path in a separate locked npm installation. That npm root must place `vue@3.5.43` beside `@vue/language-server@3.3.11`, the TypeScript plugin 3.3.11 and TypeScript 5.9.3; without `VUE_CLI`, the fixture uses this repository's locked development dependencies. The `vue@3.5.43` pin belongs to the fixture and the internal recipe, not to the manual-server requirement: an analyzed project supplies its own Vue dependencies. CI sets `VUE_CLI_REQUIRED=1`, which turns a missing `VUE_CLI` into a failure instead of the fallback, so a broken handoff cannot pass on the checkout's dependencies; local runs keep the fallback.

The Vue installation gate runs the real coordinator against the admitted recipe — the decision comes from the real admission policy — then hands the committed CLI to the Vue fixture so only one npm installation is paid:

```bash
gate_root=$(mktemp -d "${TMPDIR:-/tmp}/vue-install-gate.XXXXXX")
VUE_INSTALL_GATE_ROOT="$gate_root" VUE_INSTALL_GATE_OUTPUT="$gate_root/cli-path.txt" RUN_REAL_VUE_INSTALL=1 npm test -- test/real-servers/vue-install-gate.test.ts
VUE_CLI=$(cat "$gate_root/cli-path.txt") RUN_REAL_VUE=1 npm test -- test/real-servers/vue-language-server.test.ts
rm -rf -- "$gate_root"
```

`VUE_INSTALL_GATE_ROOT` is the directory the caller owns and removes; the gate writes the committed CLI entry to `VUE_INSTALL_GATE_OUTPUT` and keeps the installation only when both are set. A lone `VUE_INSTALL_GATE_OUTPUT` keeps nothing and writes no file, so no later step can follow a path into an installation the gate removed.

The Tailwind fixture always needs `TAILWIND_CLI`, the absolute `tailwindcss-language-server` path in a separate locked npm installation. `test/real-servers/gates/tailwindcss/package.json` and its lockfile pin `@tailwindcss/language-server@0.16.0` and `tailwindcss@4.3.3` with their integrity hashes. Build that gate in a temporary directory outside the checkout so the fixture cannot resolve packages from this repository:

```bash
gate=$(mktemp -d "${TMPDIR:-/tmp}/tailwindcss-gate.XXXXXX")
cp -R test/real-servers/gates/tailwindcss/. "$gate/"
(cd "$gate" && npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --userconfig=./npmrc --globalconfig=./global-npmrc --cache=./cache)
TAILWIND_CLI=$(node -p 'require("node:path").resolve(process.argv[1], "node_modules/@tailwindcss/language-server/bin/tailwindcss-language-server")' "$gate")
RUN_REAL_TAILWIND=1 TAILWIND_CLI="$TAILWIND_CLI" npm test -- test/real-servers/tailwindcss.test.ts
```

The gate pins belong to the fixture, not to the manual-server requirement: an analyzed project supplies its own `tailwindcss` dependency, which the language server loads from the workspace.

The Vue and Tailwind coexistence fixture diagnoses one `.vue` file with both servers. It needs the two gate installations above and pays no further npm run:

```bash
RUN_REAL_VUE=1 RUN_REAL_TAILWIND=1 VUE_CLI=<vue-language-server.js> TAILWIND_CLI=<tailwindcss-language-server> npm test -- test/real-servers/vue-tailwind-coexistence.test.ts
```

The Python installation gate (`test/real-servers/python-install-gate.test.ts`) is an opt-in, internal test for the inactive `ty` and `ruff` candidates. It makes no compatibility claim and is not wired into the catalog: the shipped registry answers `recipe_missing`, the gate injects an explicitly named allowed decision only to exercise the production adapter, coordinator, package manager and verifier, and the committed binaries are probed with `--version`, never started as a language server. It needs a fresh empty directory outside the checkout, an output path inside that directory, and an absolute, trusted global Python (>= 3.8) whose pip supports `--require-hashes`, `--only-binary` and `--target`; the key is documented in [Configuration](docs/configuration.md):

```bash
gate_root=$(mktemp -d "${TMPDIR:-/tmp}/python-install-gate.XXXXXX")
gate_root=$(node --input-type=module -e 'import { realpath } from "node:fs/promises"; process.stdout.write(await realpath(process.argv[1]));' "$gate_root")
PYTHON_INSTALL_GATE_ROOT="$gate_root" \
  PYTHON_INSTALL_GATE_OUTPUT="$gate_root/handoff.json" \
  PYTHON_GATE_INTERPRETER=<absolute-python> \
  RUN_REAL_PYTHON_INSTALL=1 \
  npm test -- test/real-servers/python-install-gate.test.ts
rm -rf -- "$gate_root"
```

The second line canonicalizes the temporary root with Node's native `realpath` before the output path is derived. The gate compares the requested output against the canonical root it claims, so a raw temporary path that is an 8.3 short name on Windows or the `/var` alias of `/private/var` on macOS would be refused as an escape; the recorded root and the cleanup stay on the same caller-owned directory.

The gate owns its root exclusively: it refuses a non-empty or symlinked root, trusts the interpreter before writing any marker, and resets only its own named scopes after re-verifying that marker. `handoff.json` is a read-only record of the committed paths and measured versions; the destructive gate is never rerun against a retained root, and every run needs a fresh unique directory. The interpreter is provisioned only for the ephemeral CI test host; production never installs Python and uses the trusted global key with its manual fallback.

The Python semantic fixtures consume that read-only handoff and never reinstall either server. Point `PYTHON_INSTALL_GATE_HANDOFF` at the `handoff.json` the gate wrote and run the opt-in fixtures in one invocation:

```bash
RUN_REAL_TY=1 RUN_REAL_RUFF=1 RUN_REAL_PYTHON_COEXISTENCE=1 PYTHON_INSTALL_GATE_HANDOFF=<handoff.json> \
  npm test -- test/real-servers/ty-language-server.test.ts test/real-servers/ruff-language-server.test.ts test/real-servers/ty-ruff-coexistence.test.ts
```

Each fixture re-hashes the committed `ty`/`ruff` executable and re-checks its wheel against the frozen lock before starting the server, and fails closed when the handoff is missing, the manifest is not `complete`, the host is unsupported, or a pinned version (`ty` 0.0.84, `ruff` 0.16.9) does not match. They resolve the server only from the handoff, never from `PATH` or the checkout.

Every server starts with an owned profile and temporary directory and with the minimal environment the production launch leaves: `PATH`, `SystemRoot`, `ComSpec`, `HOME`, `TEMP` and `TMP`, and no host `PATH`, `USERPROFILE`, `APPDATA`, `VIRTUAL_ENV`, `PYTHON*` or `PIP*` value. The fixtures assert that surviving set at the real spawn call, hash the analyzed workspace and the owned root before and after every read-only case, and restore the owned sample files a rename case edits. The initialization options they pass (`untrustedWorkspace`, `experimental.useUv`) are declared, not instrumented: they are not presented as a sandbox. `ty` and `ruff` stay candidates: these fixtures measure semantics and make no compatibility claim, so a green run on a platform without a measured row is not a compatibility row.

Document the exact server, language, Pi, Node.js, operating-system, and architecture versions for any compatibility claim. Do not describe a catalog candidate or detected executable as supported without a passing real fixture and an exact compatibility row.

## License and conduct

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE). All interactions follow the [Code of Conduct](CODE_OF_CONDUCT.md).
