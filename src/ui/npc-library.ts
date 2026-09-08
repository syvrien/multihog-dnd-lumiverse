/**
 * npc-library.ts — the shelf of NPCs you keep between campaigns.
 *
 * Lives under Campaign Records, because the two answer neighbouring questions:
 * the records are who this campaign knows, the library is who you keep.
 *
 * The useful direction is capturing *out* of a campaign. An NPC the agent has
 * been writing for twenty turns is worth keeping, and retyping them is not — so
 * "Keep from this campaign" takes a name and lifts the card straight out of the
 * tracker state.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type Library = Extract<ToFrontend, { type: 'npc:library' }>
type Exported = Extract<ToFrontend, { type: 'npc:exported' }>

export const NPC_LIBRARY_CSS = `
.dnd-npc { display: flex; flex-direction: column; gap: 8px; }
.dnd-npc__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-npc__row { display: flex; gap: 6px; flex-wrap: wrap; }
.dnd-npc__row .dnd-panel__button { flex: 0 0 auto; }
.dnd-npc__input {
  flex: 1 1 160px; min-width: 0; padding: 7px 9px; border-radius: 6px; min-height: 34px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-npc__card {
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.25)); border-radius: 8px;
  padding: 0 10px;
}
.dnd-npc__summary {
  cursor: pointer; padding: 8px 2px; font-weight: 600; list-style: none;
  display: flex; align-items: center; gap: 8px;
}
.dnd-npc__summary::-webkit-details-marker { display: none; }
.dnd-npc__summary::before { content: '▸'; opacity: .7; }
.dnd-npc__card[open] .dnd-npc__summary::before { content: '▾'; }
.dnd-npc__blurb {
  flex: 1 1 auto; min-width: 0; opacity: .7; font-size: .9em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dnd-npc__avatar { width: 26px; height: 26px; border-radius: 4px; object-fit: cover; }
.dnd-npc__body {
  width: 100%; min-height: 120px; padding: 8px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  font: inherit; font-size: 15px; line-height: 1.5;
}
.dnd-npc__io {
  width: 100%; min-height: 90px; padding: 8px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  font-family: ui-monospace, Consolas, monospace; font-size: 13px;
}
.dnd-npc__empty { opacity: .75; line-height: 1.5; }
`

export interface NpcLibraryHandle {
  root: HTMLElement
  apply(message: Library): void
  applyExport(message: Exported): void
}

export function buildNpcLibrary(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): NpcLibraryHandle {
  const root = ctx.dom.createElement('div', { class: 'dnd-npc' })

  const intro = ctx.dom.createElement('p', { class: 'dnd-npc__intro' })
  intro.textContent = 'Characters you keep between campaigns. Bring one into the '
    + 'current game as a party member or as your own character.'

  // Capture is the direction that saves real work.
  const captureRow = ctx.dom.createElement('div', { class: 'dnd-npc__row' })
  const captureName = ctx.dom.createElement('input', {
    class: 'dnd-npc__input', type: 'text',
    placeholder: 'Name of an NPC in this campaign…',
  }) as HTMLInputElement
  const capture = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  capture.textContent = 'Keep from this campaign'
  capture.addEventListener('click', () => {
    const name = captureName.value.trim()
    if (!name) { captureName.focus(); return }
    captureName.value = ''
    send({ type: 'npc:capture', name })
  })
  captureRow.append(captureName, capture)

  const list = ctx.dom.createElement('div', { class: 'dnd-npc' })

  // Import and export share one box: paste in, or read the result out.
  const io = ctx.dom.createElement('textarea', {
    class: 'dnd-npc__io',
    placeholder: 'Paste an exported NPC card here to import it…',
  }) as HTMLTextAreaElement
  io.hidden = true
  const ioRow = ctx.dom.createElement('div', { class: 'dnd-npc__row' })
  const toggleIo = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  toggleIo.textContent = 'Import…'
  toggleIo.addEventListener('click', () => {
    io.hidden = !io.hidden
    if (!io.hidden) io.focus()
  })
  const doImport = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  doImport.textContent = 'Import from box'
  doImport.addEventListener('click', () => {
    if (!io.value.trim()) return
    send({ type: 'npc:import', text: io.value })
    io.value = ''
  })
  ioRow.append(toggleIo, doImport)

  root.append(intro, captureRow, list, ioRow, io)

  return {
    root,
    apply(message) {
      list.textContent = ''
      if (!message.cards.length) {
        const empty = ctx.dom.createElement('div', { class: 'dnd-npc__empty' })
        empty.textContent = 'No cards yet. Keep one from this campaign, or import one.'
        list.appendChild(empty)
        return
      }

      for (const card of message.cards) {
        const details = ctx.dom.createElement('details', { class: 'dnd-npc__card' })
        const summary = ctx.dom.createElement('summary', { class: 'dnd-npc__summary' })
        if (card.portrait) {
          const img = ctx.dom.createElement('img', { class: 'dnd-npc__avatar' }) as HTMLImageElement
          img.src = card.portrait
          img.alt = ''
          summary.appendChild(img)
        }
        const name = ctx.dom.createElement('span')
        name.textContent = card.name
        summary.appendChild(name)
        // A stored card is a wall of labelled fields, so a row showing the raw
        // head of one tells you nothing about who they are.
        if (card.blurb) {
          const blurb = ctx.dom.createElement('span', { class: 'dnd-npc__blurb' })
          blurb.textContent = card.blurb.replace(/\s+/g, ' ').trim().slice(0, 140)
          summary.appendChild(blurb)
        }
        details.appendChild(summary)

        const body = ctx.dom.createElement('textarea', { class: 'dnd-npc__body' }) as HTMLTextAreaElement
        body.value = card.content
        const notes = ctx.dom.createElement('input', {
          class: 'dnd-npc__input', type: 'text', placeholder: 'Private notes…',
        }) as HTMLInputElement
        notes.value = card.notes

        const actions = ctx.dom.createElement('div', { class: 'dnd-npc__row' })
        const save = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        save.textContent = 'Save'
        save.addEventListener('click', () => send({
          type: 'npc:save', id: card.id, name: card.name,
          content: body.value, notes: notes.value,
        }))

        const toParty = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        toParty.textContent = 'Add to party'
        toParty.addEventListener('click', () => send({ type: 'npc:use', id: card.id, as: 'party' }))

        const asPc = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        asPc.textContent = 'Play as them'
        asPc.addEventListener('click', () => send({ type: 'npc:use', id: card.id, as: 'pc' }))

        const share = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        share.textContent = 'Export'
        share.addEventListener('click', () => send({ type: 'npc:export', id: card.id }))

        const remove = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        remove.textContent = 'Delete'
        // Two clicks, because there is no undo for a deleted card.
        let armed = false
        remove.addEventListener('click', () => {
          if (!armed) {
            armed = true
            remove.textContent = 'Really delete?'
            setTimeout(() => { armed = false; remove.textContent = 'Delete' }, 4000)
            return
          }
          send({ type: 'npc:delete', id: card.id })
        })

        actions.append(save, toParty, asPc, share, remove)
        details.append(body, notes, actions)
        list.appendChild(details)
      }
    },
    applyExport(message) {
      io.hidden = false
      io.value = message.ok
        ? (message.text ?? '')
        : `Could not export — ${message.reason ?? 'unknown reason'}.`
      io.focus()
      io.select?.()
    },
  }
}
