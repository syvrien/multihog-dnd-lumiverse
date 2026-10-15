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

In Lumiverse, use **Install from GitHub** with this repo's URL.

If you fork it, change `github` and `homepage` in [spindle.json](spindle.json)
to point at your fork before you push. The installer prefers the manifest's
value over the URL it was given, so a fork that leaves them alone registers
this repo rather than itself.

`dist/` is gitignored on purpose. Lumiverse's installer runs `bun install`
against `package.json`, then builds whichever of `dist/backend.js` /
`dist/frontend.js` is missing with a plain `bun build`, matching the two
`build:*` scripts here — so an uncommitted `dist/` builds itself on import. If
`dist/` is committed and tracked in git instead, the installer trusts it and
skips building entirely; do that only if you want to pin an exact build rather
than let the host produce one.

### Updates

Lumiverse checks installed extensions against GitHub every five minutes and
shows an update notice when the installed commit differs from the remote one.
Clicking **Update** fetches the branch, hard-resets the installed copy to it,
runs `bun install`, rebuilds `dist/` and restarts the extension. Pushing a commit
is all a release takes; nothing installs without the user clicking Update.

That only works with `"dev_mode": false` in `spindle.json`, which is what the
repo ships. With `dev_mode: true`, Lumiverse treats the copy as a developer's
working tree: it never reports an update, and Update rebuilds without fetching.
Copies installed while the repo still shipped `true` (before October 2026) are
stuck in that mode and need one reinstall to start receiving updates.

### Developing against a local Lumiverse

If your Lumiverse loads the extension through a link to your working copy, which
is the quickest way to test, then Update or Update All there would hard-reset
your working copy to GitHub's branch. Keep `dev_mode: true` on your machine only,
as a local edit git ignores:

```bash
git update-index --skip-worktree spindle.json
```

Then set `"dev_mode": true` in your local `spindle.json`. To change
`spindle.json` for real later, undo it first with
`git update-index --no-skip-worktree spindle.json`, commit with `dev_mode`
back to `false`, then repeat the two steps above.

The built backend bundle is also run through an install-time safety scan
(filesystem/subprocess/socket/SQLite imports, dangerous `Bun.*`/`process.*`
calls, `eval`/`Function`, base64-decoding `Buffer.from`) with no opt-out for
most of those. This bundle has been checked clean against every one of them.

## Long campaigns: pair it with Loom

Models get worse as prompts grow, and a long campaign's chat history grows
without bound. Lumiverse already has the pieces to cap it, and the extension
fills in around them:

1. In Lumiverse's settings, turn **Loom** on (automatic mode, every 10 messages
   by default) and turn on the **Message Limit** (around 20–30 messages).
2. That's it. When older messages are cut, the extension gives the narrator
   Loom's summary of them automatically. If your preset already uses
   `{{loomSummary}}` it is not added twice. The Lorebook Agent, World
   Progression and the Companion get the summary too, and the tracker panel
   shows it under **Story so far**. The options are in the **D&D Settings** drawer tab (**D&D Cfg**) → *General & Visuals* → *Loom summary*.

The tracker memo and the campaign lorebooks keep exact state, so cutting
history does not cost the character sheet, the NPCs or the places, and the
tracker and agents read the full chat regardless of the Message Limit.

Loom summarizes replies as they are stored, which includes CYOA menus and
hidden map blocks. Adding this to Loom's system prompt keeps them out of the
summary:

```
Ignore <choices> blocks and any hidden or <div hidden> map data; summarise only what happened in the story.
```

## Licence

GPL-3.0-or-later, inherited from upstream — see [LICENSE](LICENSE).
