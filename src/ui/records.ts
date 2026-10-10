/**
 * records.ts — the campaign encyclopedia the agent has been writing.
 *
 * Its own drawer tab, because this is something you read rather than configure.
 * Groups collapse; each shows how many entries it holds, how many are being
 * injected right now, and roughly what they cost.
 *
 * The cost is the part people act on. Active entries ride along in every
 * prompt, so a People book that has quietly grown to 4,000 tokens is a bill
 * arriving on every turn — and there was previously no way to notice.
 */

import type { SpindleDrawerTabHandle, SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'
import { buildNpcLibrary } from './npc-library'

type State = Extract<ToFrontend, { type: 'records:state' }>
type Entry = Extract<ToFrontend, { type: 'records:entry' }>

export const RECORDS_CSS = `
.dnd-rec { display: flex; flex-direction: column; gap: 10px; padding: 8px; }
.dnd-rec__head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dnd-rec__prefix {
  font-family: ui-monospace, Consolas, monospace; font-size: .85em; opacity: .75;
  word-break: break-all;
}
.dnd-rec__total { margin-left: auto; font-variant-numeric: tabular-nums; opacity: .8; }
.dnd-rec__pc {
  display: flex; gap: 10px; padding: 10px; border-radius: 8px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.3));
}
.dnd-rec__pc img {
  width: 56px; height: 56px; object-fit: cover; border-radius: 6px; flex: 0 0 auto;
}
.dnd-rec__pc-name { font-weight: 600; margin-bottom: 2px; }
.dnd-rec__pc-bio { line-height: 1.45; opacity: .9; }
.dnd-rec__group {
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.22)); border-radius: 8px;
  padding: 0 10px;
}
.dnd-rec__summary {
  cursor: pointer; padding: 9px 2px; font-weight: 600; list-style: none;
  display: flex; align-items: center; gap: 8px;
}
.dnd-rec__summary::-webkit-details-marker { display: none; }
.dnd-rec__summary::before { content: '▸'; opacity: .7; }
.dnd-rec__group[open] .dnd-rec__summary::before { content: '▾'; }
.dnd-rec__count { margin-left: auto; font-variant-numeric: tabular-nums; opacity: .75; font-weight: 400; }
.dnd-rec__entry {
  padding: 7px 4px; border-top: 1px solid var(--lumiverse-border, rgba(128,128,128,.18));
  cursor: pointer;
}
.dnd-rec__entry:hover { background: rgba(128,128,128,.08); }
.dnd-rec__label { display: flex; align-items: center; gap: 6px; }
.dnd-rec__name { flex: 1 1 auto; font-weight: 600; }
.dnd-rec__chip {
  font-size: .72em; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.4)); opacity: .85;
}
.dnd-rec__chip--active { border-color: rgba(120,200,140,.7); }
.dnd-rec__preview { opacity: .75; line-height: 1.4; margin-top: 2px; }
.dnd-rec__full {
  margin-top: 6px; padding: 8px; border-radius: 6px; white-space: pre-wrap;
  background: rgba(128,128,128,.08); line-height: 1.5;
  max-height: 320px; overflow-y: auto;
}
.dnd-rec__empty { opacity: .75; line-height: 1.5; padding: 8px; }
`

const TAB_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">'
  + '<path d="M4 4h8a2 2 0 0 1 2 2v10H6a2 2 0 0 0-2 2z"/><path d="M14 6h2v12H6"/></svg>'

/** Rough, and labelled as such — the host does not expose the tokeniser. */
const tokens = (n: number): string =>
  n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`

export interface RecordsHandle {
  apply(state: State): void
  applyEntry(entry: Entry): void
  /** The NPC library shares this tab — see below. */
  applyLibrary(message: Extract<ToFrontend, { type: 'npc:library' }>): void
  applyExport(message: Extract<ToFrontend, { type: 'npc:exported' }>): void
  dispose(): void
}

/**
 * What an empty Records tab says. The agent files every few replies, so
 * "nothing yet" after a short session is usually just "not yet" — say which.
 */
function emptyMessage(agent: State['agent']): string {
  if (agent && !agent.enabled) {
    return 'Nothing recorded — the Lorebook Agent is off, so nobody is filing people, '
      + 'places or events. Turn it on under Lorebook Agent in the settings.'
  }
  const every = agent?.runEvery ?? 0
  const next = agent?.repliesUntilNext
  if (every > 1) {
    const when = typeof next === 'number'
      ? ` The next run is ${next === 1 ? 'after the next reply' : `in ${next} replies`}.`
      : ''
    return `Nothing recorded yet. The Lorebook Agent files people, places and events every ${every} replies.${when}`
  }
  return 'Nothing recorded yet. The Lorebook Agent files people, places and events as you play.'
}

export function installRecords(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): RecordsHandle {
  let tab: SpindleDrawerTabHandle
  try {
    tab = ctx.ui.registerDrawerTab({
      id: 'records',
      title: 'Campaign Records',
      shortName: 'Records',
      description: 'People, places and events the Lorebook Agent has recorded',
      keywords: ['lore', 'records', 'npc', 'quests', 'campaign', 'dnd'],
      headerTitle: 'Records',
      iconSvg: TAB_ICON,
    })
  } catch (error) {
    console.warn('[DnD] could not register the records tab:', error)
    return {
      apply() {}, applyEntry() {}, applyLibrary() {}, applyExport() {}, dispose() {},
    }
  }

  const root = ctx.dom.createElement('div', { class: 'dnd-rec' })
  tab.root.appendChild(root)

  // The library answers the neighbouring question — the records are who this
  // campaign knows, the library is who you keep — so it lives below them
  // rather than in a tab of its own.
  const libraryTitle = ctx.dom.createElement('div', { class: 'dnd-ws__title' })
  libraryTitle.textContent = 'NPC library'
  const library = buildNpcLibrary(ctx, send)
  tab.root.append(libraryTitle, library.root)

  // Re-read on open: the agent writes between visits.
  tab.onActivate(() => {
    send({ type: 'records:read' })
    send({ type: 'npc:read' })
  })

  /** Where an opened entry's full text goes, by entry id. */
  const openBodies = new Map<string, HTMLElement>()

  return {
    apply(state) {
      root.textContent = ''
      openBodies.clear()

      if (!state.ok) {
        const note = ctx.dom.createElement('div', { class: 'dnd-rec__empty' })
        note.textContent = `Records unavailable — ${state.reason ?? 'unknown reason'}.`
        root.appendChild(note)
        return
      }

      const head = ctx.dom.createElement('div', { class: 'dnd-rec__head' })
      const prefix = ctx.dom.createElement('span', { class: 'dnd-rec__prefix' })
      prefix.textContent = state.prefix || '(no campaign yet)'
      const total = ctx.dom.createElement('span', { class: 'dnd-rec__total' })
      total.textContent = `${tokens(state.totalTokens)} tokens stored`
      head.append(prefix, total)
      root.appendChild(head)

      // Duplicating the books, not the campaign: a fresh run in a world you
      // have already built. Forking a chat carries the campaign itself, and
      // that happens on its own.
      if (state.prefix) {
        const cloneRow = ctx.dom.createElement('div', { class: 'dnd-npc__row' })
        const name = ctx.dom.createElement('input', {
          class: 'dnd-npc__input', type: 'text',
          placeholder: 'Copy this world to a new campaign name…',
          title: 'Duplicates the lorebooks under a new name. Your character and '
            + 'progress are not copied.',
        }) as HTMLInputElement
        const go = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        go.textContent = 'Copy world'
        go.addEventListener('click', () => {
          const target = name.value.trim()
          if (!target) { name.focus(); return }
          name.value = ''
          send({ type: 'campaign:clone', prefix: target })
        })
        cloneRow.append(name, go)
        root.appendChild(cloneRow)
      }

      if (state.player) {
        const card = ctx.dom.createElement('div', { class: 'dnd-rec__pc' })
        if (state.player.portrait) {
          const img = ctx.dom.createElement('img') as HTMLImageElement
          img.src = state.player.portrait
          img.alt = ''
          card.appendChild(img)
        }
        const body = ctx.dom.createElement('div')
        const name = ctx.dom.createElement('div', { class: 'dnd-rec__pc-name' })
        name.textContent = state.player.name
        const bio = ctx.dom.createElement('div', { class: 'dnd-rec__pc-bio' })
        bio.textContent = state.player.bio
        body.append(name, bio)
        card.appendChild(body)
        root.appendChild(card)
      }

      const anything = state.groups.some(group => group.count > 0)
      if (!anything) {
        const empty = ctx.dom.createElement('div', { class: 'dnd-rec__empty' })
        empty.textContent = emptyMessage(state.agent)
        root.appendChild(empty)
        return
      }

      for (const group of state.groups) {
        if (!group.count) continue
        const details = ctx.dom.createElement('details', { class: 'dnd-rec__group' })
        const summary = ctx.dom.createElement('summary', { class: 'dnd-rec__summary' })
        const label = ctx.dom.createElement('span')
        label.textContent = group.label
        const count = ctx.dom.createElement('span', { class: 'dnd-rec__count' })
        // Active is the number that costs you something every turn.
        count.textContent = `${group.count} · ${group.active} active · ${tokens(group.tokens)}`
        summary.append(label, count)
        details.appendChild(summary)

        for (const entry of group.entries) {
          const row = ctx.dom.createElement('div', { class: 'dnd-rec__entry' })
          const line = ctx.dom.createElement('div', { class: 'dnd-rec__label' })
          const name = ctx.dom.createElement('span', { class: 'dnd-rec__name' })
          name.textContent = entry.label
          line.appendChild(name)
          if (entry.active) {
            const chip = ctx.dom.createElement('span', { class: 'dnd-rec__chip dnd-rec__chip--active' })
            chip.textContent = 'in prompt'
            line.appendChild(chip)
          }
          if (entry.hasMap) {
            const chip = ctx.dom.createElement('span', { class: 'dnd-rec__chip' })
            chip.textContent = 'map'
            line.appendChild(chip)
          }
          const cost = ctx.dom.createElement('span', { class: 'dnd-rec__chip' })
          cost.textContent = tokens(entry.tokens)
          line.appendChild(cost)

          const preview = ctx.dom.createElement('div', { class: 'dnd-rec__preview' })
          preview.textContent = entry.preview

          const full = ctx.dom.createElement('div', { class: 'dnd-rec__full' })
          full.hidden = true
          openBodies.set(entry.id, full)

          row.addEventListener('click', () => {
            full.hidden = !full.hidden
            // Fetched on demand: the whole encyclopedia is too much to push
            // into the panel just because a tab was opened.
            if (!full.hidden && !full.textContent) {
              full.textContent = 'Loading…'
              send({ type: 'records:entry', id: entry.id })
            }
          })

          row.append(line, preview, full)
          details.appendChild(row)
        }
        root.appendChild(details)
      }
    },
    applyEntry(entry) {
      const target = openBodies.get(entry.id)
      if (!target) return
      // textContent, not innerHTML: lore is model output.
      target.textContent = entry.ok
        ? (entry.content || '(empty)')
        : `Could not read that entry — ${entry.reason ?? 'unknown reason'}.`
    },
    applyLibrary(message) {
      library.apply(message)
    },
    applyExport(message) {
      library.applyExport(message)
    },
    dispose() {
      tab.destroy()
    },
  }
}
