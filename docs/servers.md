# Language servers

The catalog describes routing metadata. It does not download a server, run a probe, or establish compatibility. A route is used only after the project is trusted and the effective configuration selects it.

## Admission states

| State | Meaning |
|-|-|
| `candidate` | Catalog metadata is available for manual evaluation. The entry is not detected, tested, or auto-installable. |
| `detected` | An executable was found for the route, but compatibility is not claimed. Detection is an availability fact, not a test result. |
| `tested` | The listed fixture, versions, and platforms passed the project's tests. |
| `auto-installable` | A tested entry also has a fixed internal recipe that passed integrity, isolation, cancellation, and rollback checks. |

The built-in catalog currently has one `auto-installable` entry and 31 `candidate` entries. It has no built-in `detected` or `tested` entries. `lsp_status` reports `available`, `runnable`, `routeConfigured`, `recipePresent`, and `installable` separately from `admission`.

## Built-in catalog

The following IDs are present in the catalog. Every entry other than `typescript` is a candidate only. The command and arguments shown are manual route metadata; they are not compatibility claims and are never auto-installed.

| ID | Admission | Manual command and argv | Roles |
|-|-|-|-|
| `typescript` | `auto-installable` | `typescript-language-server --stdio` | diagnostics, semantic, mutation |
| `vue` | candidate | `vue-language-server --stdio` (see [manual Vue route](#manual-vue-route)) | diagnostics, semantic, mutation |
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

### Manual Vue route

The manual Vue route requires `@vue/language-server@3.3.11`, `@vue/typescript-plugin@3.3.11`, and `typescript@5.9.3` in the same npm installation root. The project being analyzed supplies its own Vue dependencies; this route does not install them. Configure a global route whose command is the absolute Node executable and whose arguments are the absolute `<npm-root>/node_modules/@vue/language-server/bin/vue-language-server.js` path and `--stdio`. A launcher on `PATH` alone does not locate the plugin root for this bridge. The runtime checks the co-located versions before starting either process and returns `server_unavailable` with setup instructions if they are missing. The paired TypeScript process supplies script diagnostics and semantic results that Vue Language Server does not return on its own. Its rename fallback rejects edits to other files before writing. These operations passed a local Windows fixture; macOS and Linux have not yet been verified. The Vue recipe remains inactive, and a malformed CSS block did not produce a diagnostic in that fixture; neither auto-installation nor CSS diagnostics are claimed.

## TypeScript and JavaScript

The built-in TypeScript route is the only auto-installable catalog entry.

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

Automatic installation uses only the internal `typescript` recipe:

- registry: `https://registry.npmjs.org`;
- `typescript-language-server@5.3.0`;
- `typescript@5.9.3`;
- exact package-lock metadata and SHA-512 integrity values;
- lifecycle scripts disabled;
- isolated npm cache, home, prefix, and staging directories;
- executable and version verification before promotion.

Tool arguments and project configuration cannot alter this recipe. Candidates and manually configured routes have no internal recipe, so `/lsp install <candidate-id>` is rejected rather than installing an arbitrary package.

## Manual routes and language metadata

A global route can replace or add the metadata needed by a server: executable, argv, environment, LSP initialization options, extension list, language IDs, optional extension-to-language-ID mapping, roles, priority, and diagnostic timing. See [Configuration](configuration.md) for the complete schema and a reviewed migration example.

A route's extension and language-ID declarations must agree. Selection also checks the requested role and enabled state. A higher priority wins; equal priorities use the server ID for deterministic ordering. Diagnostic auxiliaries may run only when already available, while the selected primary may use the authorized installation path.
