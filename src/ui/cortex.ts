/**
 * cortex.ts — Lumiverse's memory, beside what Multihog would give it.
 *
 * Upstream tells you to install a summarizer because SillyTavern has no memory
 * of its own. Lumiverse does, so the interesting surface here is not "add a
 * summarizer" — it is the overlap. The Cortex is inferring a cast from the
 * prose while the tracker already knows one, and the only way to see whether
 * the Lorebook Agent is re-deriving what the host already holds is to put the
 * two lists next to each other.
 *
 * The sync button is deliberately understated and the copy is explicit about
 * where the data goes. Writing into host-level memory is not something
 * installing a tracker should imply, and a button that reads like a routine
 * refresh would be misleading about its blast radius.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type CortexState = Extract<ToFrontend, { type: 'cortex:state' }>
type CortexSynced = Extract<ToFrontend, { type: 'cortex:synced' }>

export const CORTEX_CSS = `
.dnd-cx { display: flex; flex-direction: column; gap: 10px; }
.dnd-cx__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-cx__cols { display: flex; gap: 10px; flex-wrap: wrap; }
.dnd-cx__col { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dnd-cx__head { font-weight: 600; display: flex; gap: 6px; align-items: baseline; }
.dnd-cx__head small { font-weight: 400; opacity: .65; }
.dnd-cx__rows {
  display: flex; flex-direction: column; gap: 2px;
  max-height: 260px; overflow-y: auto;
}
.dnd-cx__row {
  display: flex; gap: 6px; align-items: baseline;
  padding: 3px 6px; border-radius: 5px; line-height: 1.4;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.22));
}
.dnd-cx__row--both { border-color: rgba(34,197,94,.4); }
.dnd-cx__name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dnd-cx__meta { opacity: .6; font-size: .85em; white-space: nowrap; }
.dnd-cx__arc {
  padding: 6px 8px; border-radius: 6px; line-height: 1.45;
  background: rgba(128,128,128,.08);
}
.dnd-cx__actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dnd-cx__toggle { display: flex; gap: 8px; align-items: center; line-height: 1.4; }
.dnd-cx__note { line-height: 1.45; opacity: .8; }
.dnd-cx__note--warn { color: rgba(216,160,72,.95); opacity: 1; }
.dnd-cx__empty { opacity: .7; line-height: 1.5; }
`

export interface CortexHandle {
  root: HTMLElement
  apply(state: CortexState): void
  applySynced(message: CortexSynced): void
}

export function buildCortex(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): CortexHandle {
  const root = ctx.dom.createElement('div', { class: 'dnd-cx' })

  const intro = ctx.dom.createElement('p', { class: 'dnd-cx__intro' })
  intro.textContent = 'Lumiverse keeps its own memory of this chat — an entity '
    + 'graph and consolidated arcs — which is why this port does not need the '
    + 'summarizer extension the original asks for. Multihog knows things that '
    + 'memory can only guess at from the prose: who is actually in the party, '
    + 'where they stand with people, who has died. This hands those over.'

  const toggleRow = ctx.dom.createElement('label', { class: 'dnd-cx__toggle' })
  const toggle = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
  toggle.addEventListener('change', () =>
    send({ type: 'cortex:enable', enabled: toggle.checked }))
  const toggleText = ctx.dom.createElement('span')
  toggleText.textContent = 'Let Multihog write into Lumiverse’s memory'
  toggleRow.append(toggle, toggleText)

  const warn = ctx.dom.createElement('div', { class: 'dnd-cx__note dnd-cx__note--warn' })
  warn.textContent = 'This writes to your account’s memory for this chat, not to '
    + 'the extension’s own storage — it outlives the extension and other things '
    + 'on Lumiverse can read it.'

  const cols = ctx.dom.createElement('div', { class: 'dnd-cx__cols' })

  const hostCol = ctx.dom.createElement('div', { class: 'dnd-cx__col' })
  const hostHead = ctx.dom.createElement('div', { class: 'dnd-cx__head' })
  const hostTitle = ctx.dom.createElement('span')
  hostTitle.textContent = 'Lumiverse remembers'
  const hostCount = ctx.dom.createElement('small')
  hostHead.append(hostTitle, hostCount)
  const hostRows = ctx.dom.createElement('div', { class: 'dnd-cx__rows' })
  hostCol.append(hostHead, hostRows)

  const mineCol = ctx.dom.createElement('div', { class: 'dnd-cx__col' })
  const mineHead = ctx.dom.createElement('div', { class: 'dnd-cx__head' })
  const mineTitle = ctx.dom.createElement('span')
  mineTitle.textContent = 'Multihog would add'
  const mineCount = ctx.dom.createElement('small')
  mineHead.append(mineTitle, mineCount)
  const mineRows = ctx.dom.createElement('div', { class: 'dnd-cx__rows' })
  mineCol.append(mineHead, mineRows)

  cols.append(hostCol, mineCol)

  const arcsHead = ctx.dom.createElement('div', { class: 'dnd-cx__head' })
  arcsHead.textContent = 'Consolidated arcs'
  const arcs = ctx.dom.createElement('div', { class: 'dnd-cx__rows' })

  const actions = ctx.dom.createElement('div', { class: 'dnd-cx__actions' })
  const sync = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  sync.textContent = 'Hand over what Multihog knows'
  sync.addEventListener('click', () => {
    sync.disabled = true
    result.textContent = 'Writing…'
    result.hidden = false
    send({ type: 'cortex:sync' })
  })
  const refresh = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  refresh.textContent = 'Refresh'
  refresh.addEventListener('click', () => send({ type: 'cortex:read' }))
  actions.append(sync, refresh)

  const result = ctx.dom.createElement('div', { class: 'dnd-cx__note' })
  result.hidden = true

  root.append(intro, toggleRow, warn, cols, arcsHead, arcs, actions, result)

  return {
    root,
    apply(state) {
      toggle.checked = state.enabled
      sync.disabled = !state.ok || !state.enabled
      sync.title = state.enabled
        ? 'Upsert the party, the cast, mapped sites and relationship standing'
        : 'Switch the setting above on first'

      if (!state.ok) {
        hostCount.textContent = ''
        hostRows.textContent = ''
        const note = ctx.dom.createElement('div', { class: 'dnd-cx__empty' })
        note.textContent = `Lumiverse memory unavailable — ${state.reason ?? 'unknown reason'}.`
        hostRows.appendChild(note)
      } else {
        hostCount.textContent = `${state.entities.length} entities · ${state.relations.length} links`
        hostRows.textContent = ''
        if (!state.entities.length) {
          const note = ctx.dom.createElement('div', { class: 'dnd-cx__empty' })
          note.textContent = 'Nothing yet — Lumiverse builds this as the chat grows.'
          hostRows.appendChild(note)
        }
        // Anything the host already holds is marked, because that is the
        // overlap worth acting on: an NPC in both lists is one the Lorebook
        // Agent may be paying to re-describe every turn.
        const mine = new Set(state.candidates.map(entry => entry.name.toLowerCase()))
        for (const entity of state.entities) {
          const row = ctx.dom.createElement('div', { class: 'dnd-cx__row' })
          if (mine.has(entity.name.toLowerCase())) row.classList.add('dnd-cx__row--both')
          const name = ctx.dom.createElement('span', { class: 'dnd-cx__name' })
          name.textContent = entity.name
          const meta = ctx.dom.createElement('span', { class: 'dnd-cx__meta' })
          meta.textContent = [
            entity.type,
            entity.status !== 'active' ? entity.status : '',
            entity.facts ? `${entity.facts} facts` : '',
          ].filter(Boolean).join(' · ')
          row.append(name, meta)
          hostRows.appendChild(row)
        }
      }

      mineCount.textContent = `${state.candidates.length}`
      mineRows.textContent = ''
      if (!state.candidates.length) {
        const note = ctx.dom.createElement('div', { class: 'dnd-cx__empty' })
        note.textContent = 'Nothing tracked yet. Play a turn and the party fills in.'
        mineRows.appendChild(note)
      }
      const theirs = new Set(state.entities.map(entity => entity.name.toLowerCase()))
      for (const candidate of state.candidates) {
        const row = ctx.dom.createElement('div', { class: 'dnd-cx__row' })
        if (theirs.has(candidate.name.toLowerCase())) row.classList.add('dnd-cx__row--both')
        const name = ctx.dom.createElement('span', { class: 'dnd-cx__name' })
        name.textContent = candidate.name
        const meta = ctx.dom.createElement('span', { class: 'dnd-cx__meta' })
        meta.textContent = [candidate.type, candidate.relation ?? ''].filter(Boolean).join(' · ')
        row.append(name, meta)
        mineRows.appendChild(row)
      }

      arcsHead.hidden = !state.arcs.length
      arcs.textContent = ''
      arcs.hidden = !state.arcs.length
      for (const arc of state.arcs.slice(0, 6)) {
        const row = ctx.dom.createElement('div', { class: 'dnd-cx__arc' })
        row.textContent = `Tier ${arc.tier}: ${arc.summary}`
        arcs.appendChild(row)
      }
    },
    applySynced(message) {
      sync.disabled = false
      result.hidden = false
      if (!message.ok) {
        result.textContent = `Nothing was written — ${message.reason ?? 'unknown reason'}.`
        return
      }
      const parts = [
        `${message.entities} entit${message.entities === 1 ? 'y' : 'ies'}`,
        `${message.relations} link${message.relations === 1 ? '' : 's'}`,
      ]
      // Skips are reported rather than swallowed: one refused name is the
      // difference between "it worked" and "it worked for everyone but her".
      result.textContent = message.skipped.length
        ? `Handed over ${parts.join(' and ')}. ${message.skipped.length} skipped: `
          + message.skipped.slice(0, 3).join('; ')
        : `Handed over ${parts.join(' and ')}.`
    },
  }
}
