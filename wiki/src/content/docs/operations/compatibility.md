---
title: Compatibility limits
description: Check the exact server, platform, architecture, Node, and Pi rows verified for the current release.
---

Version `0.2.0` makes a compatibility claim only for the built-in TypeScript route on these tested rows:

| Operating system | Architecture | Node | Pi |
| --- | --- | --- | --- |
| Windows Server 2022 runner | x64 | 22.19.0 | 0.84.1 peer |
| macOS 14 runner | arm64 | 22.19.0 | 0.84.1 peer |
| Ubuntu 24.04 runner | x64 | 22.19.0 | 0.84.1 peer |

The route uses TypeScript Language Server `5.3.0` and TypeScript `5.9.3`. The [release CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/33570309213) exercised the invalid/clean diagnostic fixture, navigation, symbols, rename, source actions, reuse, and shutdown on those rows.

These are tested runner environments, not a promise for every Windows, macOS, or Linux release. The remaining catalog entries are candidates only. Detection, an executable starting, or a manual route existing does not establish support.

## Unreleased development rows

The `main` branch registers an `auto-installable` `vue` route with these tested rows. They are not part of the `0.2.0` release claim and are not published to npm:

| Operating system | Architecture | Node | Pi |
| --- | --- | --- | --- |
| Windows Server 2022 runner | x64 | 22.19.0 | 0.87.1 development host |
| macOS 14 runner | arm64 | 22.19.0 | 0.87.1 development host |
| Ubuntu 24.04 runner | x64 | 22.19.0 | 0.87.1 development host |

The route uses Vue Language Server `3.3.11`, `@vue/typescript-plugin` `3.3.11`, and TypeScript `5.9.3`. The [CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/36757617120) exercised diagnostics, definition, references, document symbols, prepare rename, rename, and shutdown on those rows. No CSS diagnostics are claimed.

The `main` branch also registers `auto-installable` `vscode-json-language-server` and `yaml-language-server` routes with these tested rows, also unreleased and not published to npm:

| Operating system | Architecture | Node | Pi |
| --- | --- | --- | --- |
| Windows Server 2022 runner | x64 | 22.19.0 | 1.0.1 |
| macOS 14 runner | arm64 | 22.19.0 | 1.0.1 |
| Ubuntu 24.04 runner | x64 | 22.19.0 | 1.0.1 |

The routes use `vscode-langservers-extracted` `4.10.0` and `yaml-language-server` `1.24.0`. The [Formats CI run](https://github.com/Yivas/pi-lsp-manager/actions/runs/37353289805) exercised diagnostics, process reuse, and shutdown on those rows. No semantic compatibility is claimed.

Use `lsp_status` to inspect admission and availability separately, then follow [manual-route review](/pi-lsp-manager/guides/manual-routes/) for any route without an internal recipe.

## Canonical source

[Verified language-server rows](https://github.com/Yivas/pi-lsp-manager/blob/main/docs/servers.md)
