# Language servers

## Admission states

| State | Meaning |
|-|-|
| Candidate | Recorded for evaluation only; it is neither detected nor supported. |
| Detected | The executable can be resolved, but compatibility is not claimed. |
| Tested | Clean and invalid fixtures pass on the listed versions and platforms. |
| Auto-installable | Tested, with a fixed internal recipe that also passed integrity, isolation, cancellation, and rollback checks. |

## TypeScript and JavaScript

The v1 catalog contains one enabled server.

| Field | Value |
|-|-|
| ID | `typescript` |
| Server | TypeScript Language Server `5.3.0` |
| TypeScript | `5.9.3` |
| Command | `typescript-language-server --stdio` |
| Extensions | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` |
| Language IDs | `typescript`, `typescriptreact`, `javascript`, `javascriptreact` |
| Roles | diagnostics, semantic navigation, mutation |
| Admission | Auto-installable only on platforms listed below |
| Diagnostic behavior | push diagnostics; the client waits up to 5 seconds for an initial publication |

The real fixture requires an invalid TypeScript file to produce a diagnostic and a clean file to remain clean. It also exercises definition, references, document symbols, rename, process reuse, and shutdown.

### Verified platform rows

A row is added only after the pinned GitHub Actions job succeeds.

| Operating system | Architecture | Node | Pi | Evidence |
|-|-|-|-|-|
| Windows Server 2022 runner | x64 | 22.19.0 | 0.84.1 development peer | CI matrix |
| macOS 14 runner | arm64 | 22.19.0 | 0.84.1 development peer | CI matrix |
| Ubuntu 24.04 runner | x64 | 22.19.0 | 0.84.1 development peer | CI matrix |

These rows describe the tested runners. They do not claim support for every Windows, macOS, or Linux release.

## Installation recipe

Automatic installation uses only the internal `typescript` recipe:

- registry: `https://registry.npmjs.org`;
- `typescript-language-server@5.3.0`;
- `typescript@5.9.3`;
- exact package-lock metadata and SHA-512 integrity values;
- lifecycle scripts disabled;
- isolated npm cache, home, prefix, and staging directories;
- executable and version verification before promotion.

Tool arguments and project configuration cannot alter this recipe.

## Excluded from v1

ESLint remains disabled and has no compatibility or auto-install claim. Vue, Tailwind CSS, Biome, Python, TOML, Markdown, format servers, and PowerShell are outside the v1 catalog.
