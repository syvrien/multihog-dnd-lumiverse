#!/usr/bin/env node
/**
 * port.mjs — copy engine files out of an upstream checkout and rewrite their
 * host imports to the compat layer.
 *
 * The port deliberately keeps the author's engine code intact so upstream
 * bugfixes can be pulled forward. That only stays true if the transformation is
 * reproducible, so it lives here rather than in a one-off hand edit.
 *
 *   bun scripts/port.mjs <path-to-upstream-checkout> [entry ...]
 *
 * With no entries it ports the State Tracker slice. Every file reachable from
 * the entries is copied; imports that leave the extension are rewritten to
 * ../compat/st-core.js, and anything unresolved is reported rather than
 * silently dropped.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TRACKER_SLICE = [
  'memo-processor.js',
  'renderer.js',
  'narrative-hooks.js',
  'llm-client.js',
  // Reachable only from index.js upstream, so the import walk never finds it
  // on its own — but the direct-prompt editor needs it.
  'src/state/direct-prompt-system.js',
  // Player Card generation for the Lorebook Agent. Reachable only from
  // index.js upstream.
  'character-creator.js',
  // Restores a chat's tracker snapshot on switch. Reachable only from index.js
  // upstream, so the import walk never finds it — without it the port saves
  // per-chat state and never loads it back.
  'src/features/chat/chat-state-loader.js',
  // The Adventure Companion: a side chat with a GM-ish friend that reads the
  // campaign state and can act on it. Reachable only from index.js upstream;
  // every one of its own imports is already in the tracker closure.
  'adventure-companion.js',
  // Section assembly for the narrator system prompt, plus Game Systems. Also
  // reachable only from index.js upstream.
  'game-systems.js',
  // The map renderer. DOM-free: it takes a map document and returns SVG, so it
  // runs on the backend exactly like renderer.js.
  'dungeon-map-graph.js',
  // Undo for a mangled memo, and the NPC card store. Both pure logic.
  'src/features/recovery/memo-recovery.js',
  'npc-library-lib.js',
  // Carrying a campaign into a forked chat, and duplicating a campaign's
  // lorebook stack under a new prefix. All DOM-free.
  'src/features/chat/branch-campaign-utils.js',
  'src/features/chat/clone-campaign-stack.js',
  'src/features/chat/local-chat-map.js',
  // Cleaning up after a deleted chat: its saved partition and records, and —
  // only on confirmation — lorebooks recorded for it that no other chat
  // claims. Both pure, with their I/O injected. Reachable only from index.js
  // upstream (2026.9), which wires them to its CHAT_DELETED handler.
  'src/features/chat/deleted-chat-data.js',
  'src/features/chat/purge-orphaned-lorebooks.js',
  // Game Cartridges. Its dialogs are DOM-bound and get rebuilt; the snapshot
  // and restore underneath them are not.
  'game-cartridges.js',
  // Custom panel palettes. Its wizard dialog is rebuilt; the palette variables
  // and the prompt that generates them are not.
  'theme-manager.js',
  // The scene view: where the party is, who is present, and the art for it.
  // DOM-free — it builds a scene object and returns HTML.
  'immersion.js',
  // Drops superseded <choices> blocks from the outgoing prompt. Reachable only
  // from index.js upstream, and pure array-in/array-out.
  'src/features/cyoa-prompt-history.js',
  // Hand-editing a generated map: validation, id allocation, an undo stack, and
  // the portable map package. DOM-free — its `document` parameters are map
  // documents, not the browser's.
  'map-editor-lib.js',
  // Line diffs for the shipped-prompt update dialog. No deps at all.
  'prompt-diff.js',
  /*
   * Four leaf modules from `src/ui/panel/**` — the directory this port
   * otherwise replaces. They come across because they import nothing and
   * assume nothing about SillyTavern:
   *
   *   card-synopsis      pure text extraction, runs on the backend
   *   refresh-coalescer  33 lines of promise plumbing, no DOM at all
   *   *-animation        DOM, but the *real* one: they run in the frontend
   *                      against the markup `renderer.js` already emits
   */
  'src/ui/panel/card-synopsis.js',
  'src/ui/panel/refresh-coalescer.js',
  'src/ui/panel/xp-gain-animation.js',
  'src/ui/panel/bar-change-animation.js',
]

/** Imports that leave the extension directory and land in SillyTavern core. */
const ST_CORE = /^(\.\.\/)+(script|utils|popup|bookmarks|itemized-prompts|personas|power-user|world-info|slash-commands\/SlashCommandAbortController)\.js$/

const [, , upstream, ...entryArgs] = process.argv
if (!upstream) {
  console.error('usage: bun scripts/port.mjs <upstream-checkout> [entry ...]')
  process.exit(1)
}
const entries = entryArgs.length ? entryArgs : TRACKER_SLICE
const scriptDir = dirname(fileURLToPath(import.meta.url))
const outRoot = join(scriptDir, '..', 'src', 'engine')

/** Static `from '...'` and dynamic `import('...')` both need following. */
const IMPORT_RE = /(from\s+['"]|import\(\s*['"])(\.[^'"]+)(['"])/g

/**
 * Internal functions to re-export, per file.
 *
 * Upstream keeps these module-private because its own UI is in the same file.
 * The port replaces that UI, so the logic behind it becomes unreachable — and
 * re-implementing prompt assembly in the port is exactly how a fork silently
 * diverges from the engine it claims to be tracking. Appending an export is a
 * reproducible transformation, so it lives here rather than in a hand edit.
 *
 * Anything named here that upstream does not define is reported, so a rename
 * upstream fails the port instead of quietly dropping a feature.
 */
const EXTRA_EXPORTS = {
  'adventure-companion.js': [
    'buildSystemPrompt',
    'buildNarrativeContext',
    'buildMemoContext',
    'buildLoreContext',
    'buildMapContext',
    'buildActForUserContext',
    'loadDocumentation',
    'activeModePrefs',
    'savePrefs',
    // `savePrefs` takes the whole prefs object; upstream always passes its own
    // module-level `_prefs`, so the port needs the same handle.
    '_prefs',
  ],
  'game-cartridges.js': [
    // Selective restore lives inside a checkbox dialog upstream; the port
    // rebuilds the dialog and needs the apply underneath it.
    'applyCartridgePayloadKeys',
    'uniqueCartridgeName',
  ],
  'game-systems.js': [
    // One AI call that drafts both halves of a Game System, and the commit that
    // turns an approved draft into a library entry, a tracker field and the
    // bundle linking them. Upstream keeps both private because its own wizard
    // UI lives in the same file.
    'generateGameSystemDraft',
    'saveGameSystemFromPreview',
    'WIZARD_EXAMPLE_SYSTEMS',
  ],
}

/**
 * Function-local template literals to lift into exported constants.
 *
 * `EXTRA_EXPORTS` can only reach top-level declarations. Some prompts live
 * inside the very UI function the port replaces — the theme wizard's system
 * prompt is a `const` in `openThemeWizard`'s body — so the text would be lost
 * with the dialog. Copying it into the port would be a second copy to drift;
 * lifting it keeps one, and a rename upstream fails the port rather than
 * silently shipping a stale prompt.
 *
 * Only string literals are lifted. Anything with logic in it belongs in
 * `EXTRA_EXPORTS` or stays where it is.
 */
const LIFTED_CONSTS = {
  'theme-manager.js': [{ local: 'systemPrompt', exportAs: 'THEME_WIZARD_SYSTEM_PROMPT' }],
}

const seen = new Set()
const queue = [...entries]
const missing = new Set()
const rewritten = []
const exported = []
const missingExports = []

while (queue.length) {
  const rel = queue.pop()
  if (seen.has(rel)) continue
  const src = join(upstream, rel)
  if (!existsSync(src)) {
    missing.add(rel)
    continue
  }
  seen.add(rel)

  const text = await readFile(src, 'utf8')
  const depthToRoot = rel.split('/').length - 1
  const upToEngineRoot = depthToRoot === 0 ? './' : '../'.repeat(depthToRoot)

  let out = text.replace(IMPORT_RE, (whole, open, spec, close) => {
    const resolved = normalize(join(dirname(rel), spec)).split(sep).join('/')
    if (ST_CORE.test(spec)) {
      rewritten.push(`${rel}: ${spec} -> compat/st-core.js`)
      return `${open}${upToEngineRoot}../compat/st-core.js${close}`
    }
    queue.push(resolved)
    return whole
  })

  for (const { local, exportAs } of LIFTED_CONSTS[rel] ?? []) {
    // The literal runs to the closing backtick that is not escaped.
    const match = new RegExp(`\\bconst\\s+${local}\\s*=\\s*\`((?:[^\`\\\\]|\\\\.)*)\``, 's').exec(out)
    if (!match) {
      missingExports.push(`${rel}: ${local} (lifted const)`)
      continue
    }
    out += `\n/* Lifted by scripts/port.mjs from ${local} in the replaced UI. */\n`
      + `export const ${exportAs} = \`${match[1]}\`;\n`
    exported.push(`${rel}: ${local} -> ${exportAs}`)
  }

  const extra = EXTRA_EXPORTS[rel]
  if (extra) {
    const present = extra.filter(name =>
      new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\b`, 'm').test(out)
      || new RegExp(`^\\s*(?:const|let)\\s+${name}\\b`, 'm').test(out))
    for (const name of extra) {
      if (!present.includes(name)) missingExports.push(`${rel}: ${name}`)
    }
    if (present.length) {
      out += `\n/* Added by scripts/port.mjs — the port replaces the UI these back. */\n`
        + `export { ${present.join(', ')} };\n`
      exported.push(`${rel}: ${present.join(', ')}`)
    }
  }

  const dest = join(outRoot, rel)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, out, 'utf8')
}

// The stylesheet is declared in SillyTavern's manifest (`"css": "style.css"`),
// not imported by any module, so the import walk above never reaches it. It is
// 10,925 lines and defines every `--rt-*` variable plus the rules that make
// collapsing, badges and layout work — without it the ported renderer emits
// correct markup that renders as plain text.
//
// Emitted as a TS module rather than copied as a `.css` file so the frontend
// bundle can inline it without depending on a bundler's CSS loader.
const stylePath = join(upstream, 'style.css')
if (existsSync(stylePath)) {
  const css = await readFile(stylePath, 'utf8')
  // Escaped for a template literal: a backtick would end the string and `${`
  // would start an interpolation.
  const escaped = css
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
  const moduleSource = [
    '/* Generated by scripts/port.mjs from upstream style.css. Do not edit. */',
    'export const ENGINE_CSS = `' + escaped + '`',
    '',
  ].join('\n')
  await writeFile(join(outRoot, 'style-css.ts'), moduleSource, 'utf8')
  console.log(`ported style.css (${css.split('\n').length} lines) as style-css.ts`)
} else {
  console.log('WARNING: upstream style.css not found; the panel will render unstyled')
}

// The Adventure Companion's tutorial mode answers questions about the extension
// from the manual, which it fetches from its own folder inside SillyTavern.
// That path does not exist here and the engine degrades to "documentation could
// not be loaded" — leaving tutorial mode with nothing to teach from. Bundling it
// the same way as the stylesheet is what makes the mode worth having.
/*
 * Passages the manual is wrong about *on this host*, rewritten on the way in.
 *
 * The manual is upstream's and mostly transfers verbatim, but a few paragraphs
 * describe SillyTavern's constraints rather than the extension's behaviour. The
 * summarizer advice is the sharp one: SillyTavern has no memory of its own, so
 * upstream correctly calls a summarizer *mandatory* and names Summaryception.
 * Lumiverse ships a hybrid memory architecture, and Summaryception is not
 * installable here — so following that advice is impossible and the thing it
 * asks for is already present.
 *
 * This matters because the Adventure Companion loads the manual into its prompt
 * in tutorial mode: left alone, asking the companion about context growth gets
 * you sent after an extension that does not exist.
 *
 * Each entry fails the port if its `find` text stops matching, so an upstream
 * rewording surfaces here instead of silently restoring the wrong advice.
 */
const DOC_SUBSTITUTIONS = [
  {
    find: 'Suggested companion: **[Summaryception](https://github.com/Lodactio/Extension-Summaryception)**',
    replace: 'Suggested companion (SillyTavern only): **[Summaryception](https://github.com/Lodactio/Extension-Summaryception)**'
      + '\n\n> **On Lumiverse this is already handled.** The host ships its own memory —'
      + ' vectorised chat retrieval behind the `{{memories}}` macro, an entity graph with'
      + ' salience scoring, and tiered consolidations. There is no summarizer to install and'
      + ' nothing to configure in this extension for it. See Settings -> Lorebook Agent ->'
      + ' Lumiverse memory, which also hands the tracker’s own party, cast, standings and'
      + ' mapped sites to that graph.\n\n> Original note:',
  },
  {
    // The "pairs with a summarizer" framing is the other place a reader is sent
    // looking for one. On Lumiverse the partner is the host's own memory.
    find: 'It is intended to pair with a summarizer (e.g. Summaryception) that keeps a rough arc;',
    replace: 'It is intended to pair with something that keeps a rough arc — on SillyTavern a'
      + ' summarizer extension, on Lumiverse the Memory Cortex the host already ships, which'
      + ' does the same job and more with nothing to install;',
  },
]

const docPath = join(upstream, 'docs', 'multihogDnDdoc.md')
if (existsSync(docPath)) {
  let doc = await readFile(docPath, 'utf8')
  for (const { find, replace } of DOC_SUBSTITUTIONS) {
    if (!doc.includes(find)) {
      missingExports.push(`doc: substitution text not found -> ${find.slice(0, 60)}`)
      continue
    }
    doc = doc.replace(find, replace)
  }
  const escaped = doc
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
  await writeFile(
    join(outRoot, 'doc-md.ts'),
    [
      '/* Generated by scripts/port.mjs from upstream docs/multihogDnDdoc.md. Do not edit. */',
      'export const ENGINE_DOC = `' + escaped + '`',
      '',
    ].join('\n'),
    'utf8',
  )
  console.log(`ported multihogDnDdoc.md (${doc.split('\n').length} lines) as doc-md.ts`)
} else {
  console.log('WARNING: upstream docs/multihogDnDdoc.md not found; tutorial mode will have no manual')
}

const total = seen.size
console.log(`ported ${total} file(s) into ${relative(process.cwd(), outRoot)}`)
if (rewritten.length) {
  console.log(`\nrewritten host imports (${rewritten.length}):`)
  for (const line of rewritten) console.log(`  ${line}`)
}
if (exported.length) {
  console.log(`\nre-exported internals (${exported.length}):`)
  for (const line of exported) console.log(`  ${line}`)
}
if (missingExports.length) {
  console.log(`\nMISSING — asked to export these, but upstream no longer defines them:`)
  for (const line of missingExports) console.log(`  ${line}`)
  process.exitCode = 1
}
if (missing.size) {
  console.log(`\nUNRESOLVED — these left the extension and need a compat shim:`)
  for (const line of [...missing].sort()) console.log(`  ${line}`)
  process.exitCode = 1
}
