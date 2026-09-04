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

The built-in catalog has one `auto-installable` entry and 31 candidates. `lsp_status` separately reports availability, route configuration, recipe presence, installability, and admission.

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

It is the only built-in route with an installation recipe. The recipe uses the npm registry, exact lock metadata and SHA-512 integrities, `npm ci`, disabled lifecycle scripts, isolated directories, and executable/version verification before promotion.

## Candidate routes

The catalog also lists candidates such as `biome`, `eslint`, `rust-analyzer`, `gopls`, `clangd`, `jdtls`, `yaml-language-server`, and `terraform-ls`. Candidates are not supported merely because they are listed, detected, or start successfully. `jdtls` has no built-in command route and needs complete global metadata.

Review current server documentation and the installed executable before configuring a candidate. A route must declare compatible extensions, language IDs, and roles. Higher priority wins; ties use server ID. Read [manual routes](/pi-lsp-manager/guides/manual-routes/) and the [compatibility limits](/pi-lsp-manager/operations/compatibility/).

## Canonical source

[Language server catalog](https://github.com/Yivas/pi-lsp-manager/blob/main/docs/servers.md)
