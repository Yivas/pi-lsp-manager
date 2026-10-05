---
title: Language servers
description: Distinguish candidate, detected, tested, and auto-installable language-server entries.
---

Catalog metadata does not download, probe, or establish compatibility. A route runs only after a project is trusted and effective configuration selects it.

## Admission states

| State | Meaning |
| --- | --- |
| `candidate` | Metadata for manual evaluation; not detected, tested, or auto-installable. |
| `detected` | An executable was found; this is not a compatibility claim. |
| `tested` | The listed fixture, versions, and platforms passed project tests. |
| `auto-installable` | A tested entry with a fixed internal recipe that passed installation controls. |

The built-in catalog has four `auto-installable` entries (`typescript`, `vue`, `vscode-json-language-server`, and `yaml-language-server`) and 29 candidates. `lsp_status` separately reports availability, route configuration, recipe presence, installability, and admission.

## Built-in TypeScript route

| Field | Value |
| --- | --- |
| ID | `typescript` |
| Server | TypeScript Language Server `5.3.0` |
| TypeScript | `5.9.3` |
| Command | `typescript-language-server --stdio` |
| Extensions | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` |
| Roles | diagnostics, semantic, mutation |
| Priority | `100` |

Every auto-installable route uses an internal recipe with the npm registry, exact lock metadata and SHA-512 integrities, `npm ci`, disabled lifecycle scripts, isolated directories, and executable/version verification before promotion.

## Built-in Vue route

| Field | Value |
| --- | --- |
| ID | `vue` |
| Server | Vue Language Server `3.3.11` |
| Plugin | `@vue/typescript-plugin` `3.3.11` |
| TypeScript | `5.9.3` |
| Command | `vue-language-server --stdio` |
| Extensions | `.vue` |
| Roles | diagnostics, semantic, mutation |
| Priority | `100` |

The `vue` recipe installs the pinned server, plugin, TypeScript, and Vue closure. A manual route instead needs the server, plugin, and TypeScript co-located in one npm root. Its paired TypeScript process supplies script diagnostics and semantic results; no CSS diagnostics are claimed.

## Built-in JSON and YAML routes

| Field | JSON server | YAML server |
| --- | --- | --- |
| ID | `vscode-json-language-server` | `yaml-language-server` |
| Package | `vscode-langservers-extracted` `4.10.0` | `yaml-language-server` `1.24.0` |
| Command | `vscode-json-language-server --stdio` | `yaml-language-server --stdio` |
| Extensions | `.json`, `.jsonc` | `.yaml`, `.yml` |
| Roles | diagnostics, semantic, mutation | diagnostics, semantic, mutation |

Each route has an internal recipe with its own complete lockfile and integrities. The `main` branch registers them with tested rows that are not part of the published `0.2.0` release. The verified rows cover diagnostics, process reuse, and shutdown only, so no semantic compatibility is claimed. See the [compatibility limits](/pi-lsp-manager/operations/compatibility/).

## Candidate routes

The catalog also lists candidates such as `biome`, `eslint`, `rust-analyzer`, `gopls`, `clangd`, `jdtls`, and `terraform-ls`. Candidates are not supported merely because they are listed, detected, or start successfully. `jdtls` has no built-in command route and needs complete global metadata.

Review current server documentation and the installed executable before configuring a candidate. A route must declare compatible extensions, language IDs, and roles. Higher priority wins; ties use server ID. Read [manual routes](/pi-lsp-manager/guides/manual-routes/) and the [compatibility limits](/pi-lsp-manager/operations/compatibility/).

## Canonical source

[Language server catalog](https://github.com/Yivas/pi-lsp-manager/blob/main/docs/servers.md)
