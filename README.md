# Multihog D&D Framework — Lumiverse port

A port of [SillyTavern-MultihogDnDFramework](https://github.com/MultihogAurelius/SillyTavern-MultihogDnDFramework)
to Lumiverse's Spindle extension system. The upstream author has put the project
into maintenance mode and explicitly encourages forks.

**Status: early.** The compatibility layer and the State Tracker scaffolding are
in place and build clean. Most subsystems are ported but not yet wired up. See
[PORTING.md](PORTING.md) for the full mapping, the behavioural differences, and
what is left.

## Layout

```
src/
  backend.ts        Spindle backend entry — boot, events, interceptor
  frontend.ts       Spindle frontend entry — drawer tab, panel, popups
  compat/           SillyTavern API shims over Spindle
  engine/           ported upstream engine (generated — do not hand-edit)
  shared/           the backend <-> frontend message contract
  types/            local Spindle type declarations
scripts/port.mjs    regenerates src/engine/ from an upstream checkout
```

`src/engine/` is generated. Fix things in the compat layer or upstream, then
re-run the port script — hand edits there are lost on the next run.

## Build and test

```bash
bun install && bun run build && bun run test
```

`bun run test` boots the backend against an in-memory fake host
(`tests/fake-spindle.ts`) and checks the tracker path end to end — no Lumiverse
instance required.

`bun run typecheck` checks the hand-written half; the generated engine is
JavaScript and is checked by bundling, not by `tsc`. Use `bun run typecheck`
rather than `npx tsc` — npx resolves an unrelated `tsc` package from the
registry instead of the local TypeScript.

## Install into a Lumiverse checkout

`Import Local` in the Extensions panel scans only `<dataDir>/extensions/`, and
expects a nested `repo/` layout. It never looks at `spindle-extensions/` — that
holds the source of Lumiverse's own bundled suite, not an install location.

Rather than copying this repo in (where it drifts from the source you edit),
link it. From PowerShell, with `$LUMI` set to your Lumiverse checkout:

```powershell
$src = "C:\Users\shigu\Projects\multihog-dnd-lumiverse"
$ext = "$LUMI\data\extensions\multihog_dnd"
New-Item -ItemType Directory -Force -Path $ext, "$ext\storage" | Out-Null
New-Item -ItemType Junction -Path "$ext\repo" -Target $src
```

Then click **Import Local**, enable the extension, and grant permissions.
`dev_mode: true` in the manifest stops Lumiverse running git operations against
the linked tree, so the junction survives updates.

Build before installing (`bun install && bun run build`) — the host serves
`dist/`, and auto-build only runs when `dist/` is absent entirely.

## Permissions

The manifest requests `generation`, `interceptor`, `tools`, `chats`,
`chat_mutation`, `world_books`, `characters`, and `ui_panels`. Without
`interceptor` the state memo is never injected; without `world_books` the
Lorebook Agent cannot run.

Installed through `Import Local` the extension is **operator-scoped**, so it
must name a user on every user-scoped call — see "Scope: one user at a time" in
[PORTING.md](PORTING.md).

## Publishing and installing via GitHub

Push this repo to your own GitHub, then in Lumiverse use **Install from
GitHub** with that URL. Set `github` and `homepage` in
[spindle.json](spindle.json) to that URL before you push: the installer prefers
the manifest's value over the URL it was given, so leaving them as they are
registers the wrong repo even when you install from the right one.

`dist/` is gitignored on purpose. Lumiverse's installer runs `bun install`
against `package.json`, then builds whichever of `dist/backend.js` /
`dist/frontend.js` is missing with a plain `bun build`, matching the two
`build:*` scripts here — so an uncommitted `dist/` builds itself on import. If
`dist/` is committed and tracked in git instead, the installer trusts it and
skips building entirely; do that only if you want to pin an exact build rather
than let the host produce one.

The built backend bundle is also run through an install-time safety scan
(filesystem/subprocess/socket/SQLite imports, dangerous `Bun.*`/`process.*`
calls, `eval`/`Function`, base64-decoding `Buffer.from`) with no opt-out for
most of those. This bundle has been checked clean against every one of them.

## Licence

GPL-3.0-or-later, inherited from upstream — see [LICENSE](LICENSE).
