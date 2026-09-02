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

Use `lsp_status` to inspect admission and availability separately, then follow [manual-route review](/pi-lsp-manager/guides/manual-routes/) for any non-TypeScript server.

## Canonical source

[Verified language-server rows](https://github.com/Yivas/pi-lsp-manager/blob/main/docs/servers.md)
