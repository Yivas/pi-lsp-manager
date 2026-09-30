# Language servers

The catalog describes routing metadata. It does not download a server, run a probe, or establish compatibility. A route is used only after the project is trusted and the effective configuration selects it.

## Admission states

| State | Meaning |
|-|-|
| `candidate` | Catalog metadata is available for manual evaluation. The entry is not detected, tested, or auto-installable. |
| `detected` | An executable was found for the route, but compatibility is not claimed. Detection is an availability fact, not a test result. |
| `tested` | The listed fixture, versions, and platforms passed the project's tests. |
| `auto-installable` | A tested entry also has a fixed internal recipe that passed integrity, isolation, cancellation, and rollback checks. |

The built-in catalog currently has two `auto-installable` entries (`typescript` and `vue`) and 30 `candidate` entries. It has no built-in `detected` or `tested` entries. `lsp_status` reports `available`, `runnable`, `routeConfigured`, `recipePresent`, and `installable` separately from `admission`. Fixture runs against a manually configured route do not change the entry's admission or create a compatibility row; an entry becomes `tested` only through a registered compatibility row.

## Built-in catalog

The following IDs are present in the catalog. Every entry other than `typescript` and `vue` is a candidate only. The command and arguments shown are the route metadata; they are not compatibility claims and are never auto-installed from that metadata alone. Fixture evidence for one manual route does not extend to another entry: no CSS diagnostics or Tailwind support are claimed.

| ID | Admission | Manual command and argv | Roles |
|-|-|-|-|
| `typescript` | `auto-installable` | `typescript-language-server --stdio` | diagnostics, semantic, mutation |
| `vue` | `auto-installable` | `vue-language-server --stdio` (see [Vue route](#vue-route)) | diagnostics, semantic, mutation |
| `biome` | candidate | `biome lsp-proxy` | diagnostics |
| `tailwindcss` | candidate | `tailwindcss-language-server --stdio` | diagnostics |
| `eslint` | candidate | `vscode-eslint-language-server --stdio` | diagnostics |
| `ty` | candidate | `ty server` | diagnostics, semantic, mutation |
| `ruff` | candidate | `ruff server` | diagnostics |
| `rust-analyzer` | candidate | `rust-analyzer` | diagnostics, semantic, mutation |
| `gopls` | candidate | `gopls` | diagnostics, semantic, mutation |
| `rubocop` | candidate | `rubocop --lsp` | diagnostics |
| `elixir-ls` | candidate | `language_server.sh` | diagnostics, semantic, mutation |
| `zls` | candidate | `zls` | diagnostics, semantic, mutation |
| `csharp` | candidate | `csharp-ls` | diagnostics, semantic, mutation |
| `fsharp` | candidate | `fsautocomplete` | diagnostics, semantic, mutation |
| `sourcekit-lsp` | candidate | `sourcekit-lsp` | diagnostics, semantic, mutation |
| `clangd` | candidate | `clangd` | diagnostics, semantic, mutation |
| `jdtls` | candidate | no built-in route | diagnostics, semantic, mutation |
| `kotlin-lsp` | candidate | `kotlin-lsp.sh` | diagnostics, semantic, mutation |
| `yaml-language-server` | candidate | `yaml-language-server --stdio` | diagnostics, semantic, mutation |
| `lua-language-server` | candidate | `lua-language-server` | diagnostics, semantic, mutation |
| `intelephense` | candidate | `intelephense --stdio` | diagnostics, semantic, mutation |
| `prisma` | candidate | `prisma-language-server --stdio` | diagnostics, semantic, mutation |
| `dart` | candidate | `dart language-server --protocol=lsp` | diagnostics, semantic, mutation |
| `ocaml-lsp` | candidate | `ocamllsp` | diagnostics, semantic, mutation |
| `bash-language-server` | candidate | `bash-language-server start` | diagnostics, semantic, mutation |
| `terraform-ls` | candidate | `terraform-ls serve` | diagnostics, semantic, mutation |
| `texlab` | candidate | `texlab` | diagnostics, semantic, mutation |
| `gleam` | candidate | `gleam lsp` | diagnostics, semantic, mutation |
| `clojure-lsp` | candidate | `clojure-lsp` | diagnostics, semantic, mutation |
| `nixd` | candidate | `nixd` | diagnostics, semantic, mutation |
| `tinymist` | candidate | `tinymist` | diagnostics, semantic, mutation |
| `haskell-language-server` | candidate | `haskell-language-server-wrapper --lsp` | diagnostics, semantic, mutation |

Before using a candidate, review its catalog route and installed executable against the server's current documentation. Global configuration can override that route or supply a different complete route. `jdtls` has no built-in command route, so it requires `command`, `args`, `extensions`, `languageIds`, `roles`, and any required initialization or environment values in global configuration. A candidate is not supported merely because its executable is present or starts successfully.

### Vue route

`vue` is `auto-installable` through an internal recipe and also works as a manual route. The recipe installs `@vue/language-server@3.3.11`, `@vue/typescript-plugin@3.3.11`, `typescript@5.9.3` and `vue@3.5.43` from its own complete lockfile. A manual route requires `@vue/language-server@3.3.11`, `@vue/typescript-plugin@3.3.11`, and `typescript@5.9.3` in the same npm installation root. The analyzed project supplies its own workspace Vue dependency; the recipe installs only the extension-owned server closure. Configure a global route whose command is the absolute Node executable and whose arguments are the absolute `<npm-root>/node_modules/@vue/language-server/bin/vue-language-server.js` path and `--stdio`. A launcher on `PATH` alone does not locate the plugin root for this bridge. The runtime checks the co-located versions before starting either process and returns `server_unavailable` with setup instructions if they are missing. The paired TypeScript process supplies script diagnostics and semantic results that Vue Language Server does not return on its own. Its rename fallback rejects edits to other files before writing.

The Vue fixture passed in CI on Windows Server 2022 x64, macOS 14 arm64, and Ubuntu 24.04 x64 with Node 22.19.0 and the 0.87.1 development host, against a locked installation built outside the checkout (`@vue/language-server@3.3.11`, `@vue/typescript-plugin@3.3.11`, `typescript@5.9.3`, and the fixture's `vue@3.5.43`) in runs [36577613761](https://github.com/Yivas/pi-lsp-manager/actions/runs/36577613761), [36583822782](https://github.com/Yivas/pi-lsp-manager/actions/runs/36583822782), [36598277835](https://github.com/Yivas/pi-lsp-manager/actions/runs/36598277835), and [36613182803](https://github.com/Yivas/pi-lsp-manager/actions/runs/36613182803).

The fixture exercises diagnostics on an invalid script block, an invalid JavaScript block, and an invalid template, together with definition, references, document symbols, prepare rename, rename across script and template, a clean file, an untrusted project, and cancellation.

Those runs plus the locked installation and the admitted recipe support the verified Vue rows below. The row covers the tested runner, not every Windows, macOS, or Linux release. A malformed CSS block in that fixture still produced no diagnostic, so no CSS diagnostics are claimed.

#### Verified Vue platform rows

A row is added only after the pinned GitHub Actions job succeeds.

| Operating system | Architecture | Node | Pi | Evidence |
|-|-|-|-|-|
| Windows Server 2022 runner | x64 | 22.19.0 | 0.87.1 development host | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/36757617120) |
| macOS 14 runner | arm64 | 22.19.0 | 0.87.1 development host | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/36757617120) |
| Ubuntu 24.04 runner | x64 | 22.19.0 | 0.87.1 development host | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/36757617120) |

## TypeScript and JavaScript

The built-in TypeScript route is `auto-installable`.

| Field | Value |
|-|-|
| ID | `typescript` |
| Server | TypeScript Language Server `5.3.0` |
| TypeScript | `5.9.3` |
| Command | `typescript-language-server --stdio` |
| Extensions | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` |
| Language IDs | `typescript`, `typescriptreact`, `javascript`, `javascriptreact` |
| Extension mapping | `.ts`/`.mts` → `typescript`; `.tsx` → `typescriptreact`; `.js`/`.mjs`/`.cjs` → `javascript`; `.jsx` → `javascriptreact` |
| Roles | diagnostics, semantic, mutation |
| Priority | `100` |
| Admission | auto-installable only on the verified rows below |
| Diagnostic behavior | push diagnostics; the client waits up to 5 seconds for an initial publication |

The real fixture uses an invalid TypeScript file that must produce a diagnostic and a clean file that must remain clean. It also exercises definitions, references, document symbols, rename, source actions, process reuse, and shutdown.

### Verified platform rows

A row is added only after the pinned GitHub Actions job succeeds.

| Operating system | Architecture | Node | Pi | Evidence |
|-|-|-|-|-|
| Windows Server 2022 runner | x64 | 22.19.0 | 0.84.1 peer | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/33570309213) |
| macOS 14 runner | arm64 | 22.19.0 | 0.84.1 peer | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/33570309213) |
| Ubuntu 24.04 runner | x64 | 22.19.0 | 0.84.1 peer | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/33570309213) |
| Windows Server 2022 runner | x64 | 22.19.0 | 0.87.1 development host | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/36497904211) |
| macOS 14 runner | arm64 | 22.19.0 | 0.87.1 development host | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/36497904211) |
| Ubuntu 24.04 runner | x64 | 22.19.0 | 0.87.1 development host | [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/36497904211) |

The 0.84.1 rows record the original release fixture; the 0.87.1 rows record the current development host. Each row covers its tested runner, not every Windows, macOS, or Linux release or every Pi peer version.

## Installation recipe

Automatic installation uses only the internal `typescript` and `vue` recipes. Both use:

- registry: `https://registry.npmjs.org`;
- exact package-lock metadata and SHA-512 integrity values;
- `npm ci` with lifecycle scripts disabled;
- isolated npm cache, home, prefix, and staging directories;
- executable and version verification before promotion.

The `typescript` recipe pins `typescript-language-server@5.3.0` and `typescript@5.9.3`. The `vue` recipe pins `@vue/language-server@3.3.11`, `@vue/typescript-plugin@3.3.11`, `typescript@5.9.3` and `vue@3.5.43` with its own complete lockfile; its paired TypeScript process still requires the co-located plugin. Tool arguments and project configuration cannot alter either recipe. Candidates and manually configured routes have no internal recipe, so `/lsp install <candidate-id>` is rejected rather than installing an arbitrary package.

## Manual routes and language metadata

A global route can replace or add the metadata needed by a server: executable, argv, environment, LSP initialization options, extension list, language IDs, optional extension-to-language-ID mapping, roles, priority, and diagnostic timing. See [Configuration](configuration.md) for the complete schema and a reviewed migration example.

A route's extension and language-ID declarations must agree. Selection also checks the requested role and enabled state. A higher priority wins; equal priorities use the server ID for deterministic ordering. Diagnostic auxiliaries may run only when already available, while the selected primary may use the authorized installation path.
