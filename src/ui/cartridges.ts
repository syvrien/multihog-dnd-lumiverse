/**
 * cartridges.ts — saved configurations.
 *
 * Sits at the bottom of the settings surface, because a cartridge is every
 * setting above it in one bundle.
 *
 * The load step is the one that needs care. Loading a cartridge replaces
 * configuration wholesale, and someone who took one for its Game Systems will
 * not expect their dice settings to change with it — so a cartridge opens into
 * a list of what it holds, with everything checked, and anything unchecked is
 * left exactly as it is. Groups that match the shipped defaults are marked, so
 * "this part is stock" is visible before you take it.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type State = Extract<ToFrontend, { type: 'cartridge:state' }>
type Detail = Extract<ToFrontend, { type: 'cartridge:detail' }>
type Exported = Extract<ToFrontend, { type: 'cartridge:exported' }>

export const CARTRIDGE_CSS = `
.dnd-cart { display: flex; flex-direction: column; gap: 10px; }
.dnd-cart__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-cart__row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dnd-cart__input {
  flex: 1 1 160px; min-width: 0; padding: 7px 9px; border-radius: 6px; min-height: 34px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-cart__item {
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.25)); border-radius: 8px;
  padding: 0 10px;
}
.dnd-cart__summary {
  cursor: pointer; padding: 9px 2px; font-weight: 600; list-style: none;
  display: flex; align-items: center; gap: 8px;
}
.dnd-cart__summary::-webkit-details-marker { display: none; }
.dnd-cart__summary::before { content: '▸'; opacity: .7; }
.dnd-cart__item[open] .dnd-cart__summary::before { content: '▾'; }
.dnd-cart__note { margin-left: auto; font-weight: 400; opacity: .7; font-size: .9em; }
.dnd-cart__group {
  display: flex; align-items: flex-start; gap: 8px; padding: 5px 2px;
  border-top: 1px solid var(--lumiverse-border, rgba(128,128,128,.18));
}
.dnd-cart__group input { margin-top: 3px; cursor: pointer; }
.dnd-cart__glabel { flex: 1 1 auto; }
.dnd-cart__gdesc { display: block; opacity: .7; font-size: .9em; line-height: 1.4; }
.dnd-cart__stock {
  font-size: .72em; padding: 1px 6px; border-radius: 999px; opacity: .8;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.4));
}
.dnd-cart__io {
  width: 100%; min-height: 90px; padding: 8px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  font-family: ui-monospace, Consolas, monospace; font-size: 13px;
}
.dnd-cart__empty { opacity: .75; line-height: 1.5; }
`

export interface CartridgeHandle {
  root: HTMLElement
  apply(state: State): void
  applyDetail(detail: Detail): void
  applyExport(message: Exported): void
}

export function buildCartridges(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): CartridgeHandle {
  const root = ctx.dom.createElement('div', { class: 'dnd-cart' })

  const intro = ctx.dom.createElement('p', { class: 'dnd-cart__intro' })
  intro.textContent = 'A named snapshot of every setting above — the ruleset, '
    + 'Game Systems, the agent\'s record types, dice and display. Configuration '
    + 'only: no campaign, no characters, no lore.'

  const saveRow = ctx.dom.createElement('div', { class: 'dnd-cart__row' })
  const saveName = ctx.dom.createElement('input', {
    class: 'dnd-cart__input', type: 'text', placeholder: 'Save this setup as…',
  }) as HTMLInputElement
  const save = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  save.textContent = 'Save'
  save.addEventListener('click', () => {
    const name = saveName.value.trim()
    if (!name) { saveName.focus(); return }
    saveName.value = ''
    send({ type: 'cartridge:save', name, description: '', icon: '💾' })
  })
  saveRow.append(saveName, save)

  const list = ctx.dom.createElement('div', { class: 'dnd-cart' })

  const io = ctx.dom.createElement('textarea', {
    class: 'dnd-cart__io',
    placeholder: 'Paste a shared cartridge here to import it…',
  }) as HTMLTextAreaElement
  io.hidden = true
  const ioRow = ctx.dom.createElement('div', { class: 'dnd-cart__row' })
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
    send({ type: 'cartridge:import', text: io.value })
    io.value = ''
  })
  ioRow.append(toggleIo, doImport)

  root.append(intro, saveRow, list, ioRow, io)

  /** Group checkboxes per cartridge, filled once its detail arrives. */
  const groupHosts = new Map<string, HTMLElement>()
  const groupBoxes = new Map<string, Map<string, HTMLInputElement>>()

  return {
    root,
    apply(state) {
      list.textContent = ''
      groupHosts.clear()
      groupBoxes.clear()

      if (!state.cartridges.length) {
        const empty = ctx.dom.createElement('div', { class: 'dnd-cart__empty' })
        empty.textContent = 'No saved setups yet. Save this one, or import a shared cartridge.'
        list.appendChild(empty)
      }

      for (const cartridge of state.cartridges) {
        const item = ctx.dom.createElement('details', { class: 'dnd-cart__item' })
        const summary = ctx.dom.createElement('summary', { class: 'dnd-cart__summary' })
        const label = ctx.dom.createElement('span')
        label.textContent = `${cartridge.icon} ${cartridge.name}`
        const note = ctx.dom.createElement('span', { class: 'dnd-cart__note' })
        note.textContent = cartridge.description
        summary.append(label, note)
        item.appendChild(summary)

        const groups = ctx.dom.createElement('div')
        const loading = ctx.dom.createElement('div', { class: 'dnd-cart__empty' })
        loading.textContent = 'Opening…'
        groups.appendChild(loading)
        groupHosts.set(cartridge.id, groups)

        // Contents are fetched when opened, not pushed for every cartridge.
        item.addEventListener('toggle', () => {
          if ((item as HTMLDetailsElement).open && !groupBoxes.has(cartridge.id)) {
            send({ type: 'cartridge:inspect', id: cartridge.id })
          }
        })

        const actions = ctx.dom.createElement('div', { class: 'dnd-cart__row' })
        const load = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        load.textContent = 'Load checked'
        load.addEventListener('click', () => {
          const boxes = groupBoxes.get(cartridge.id)
          const chosen = [...(boxes?.entries() ?? [])]
            .filter(([, box]) => box.checked)
            .map(([id]) => id)
          if (!chosen.length) return
          send({ type: 'cartridge:load', id: cartridge.id, groups: chosen })
        })

        const share = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        share.textContent = 'Export'
        share.addEventListener('click', () => send({ type: 'cartridge:export', id: cartridge.id }))

        const remove = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        remove.textContent = 'Delete'
        // Two clicks: a deleted cartridge is not recoverable.
        let armed = false
        remove.addEventListener('click', () => {
          if (!armed) {
            armed = true
            remove.textContent = 'Really delete?'
            setTimeout(() => { armed = false; remove.textContent = 'Delete' }, 4000)
            return
          }
          send({ type: 'cartridge:delete', id: cartridge.id })
        })

        actions.append(load, share, remove)
        item.append(groups, actions)
        list.appendChild(item)
      }
    },
    applyDetail(detail) {
      const host = groupHosts.get(detail.id)
      if (!host) return
      host.textContent = ''

      if (!detail.ok || !detail.groups) {
        const note = ctx.dom.createElement('div', { class: 'dnd-cart__empty' })
        note.textContent = `Could not read it — ${detail.reason ?? 'unknown reason'}.`
        host.appendChild(note)
        return
      }

      const boxes = new Map<string, HTMLInputElement>()
      for (const group of detail.groups) {
        const row = ctx.dom.createElement('label', { class: 'dnd-cart__group' })
        const box = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
        // Everything on by default; unchecking is the deliberate act.
        box.checked = true
        const text = ctx.dom.createElement('span', { class: 'dnd-cart__glabel' })
        text.textContent = group.label
        const desc = ctx.dom.createElement('small', { class: 'dnd-cart__gdesc' })
        desc.textContent = group.description
        text.appendChild(desc)
        row.append(box, text)
        if (!group.changed) {
          // Loading a stock group changes nothing; saying so beats letting
          // someone wonder why nothing happened.
          const chip = ctx.dom.createElement('span', { class: 'dnd-cart__stock' })
          chip.textContent = 'stock'
          row.appendChild(chip)
        }
        host.appendChild(row)
        boxes.set(group.id, box)
      }
      groupBoxes.set(detail.id, boxes)
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
