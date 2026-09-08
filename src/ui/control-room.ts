/**
 * control-room.ts — what the narrator is told.
 *
 * The ruleset is ~25 KB on every single generation, and until now none of it
 * was being sent at all. Now that it is, the user needs to see what is in it
 * and be able to take parts out — both to change how the game plays and to stop
 * paying for rules they do not use.
 *
 * Upstream's Control Room also reorders sections by drag. That is deferred:
 * order rarely changes behaviour, and a drag list is a poor fit for the drawer.
 * Enabling is where the value is.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type Sections = Extract<ToFrontend, { type: 'sysprompt:sections' }>

export const CONTROL_ROOM_CSS = `
.dnd-cr { display: flex; flex-direction: column; gap: 10px; }
.dnd-cr__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-cr__size { font-variant-numeric: tabular-nums; }
.dnd-cr__list { display: flex; flex-direction: column; gap: 2px; }
.dnd-cr__row {
  display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 5px;
}
.dnd-cr__row:hover { background: rgba(128,128,128,.1); }
.dnd-cr__row input { cursor: pointer; }
.dnd-cr__name { flex: 1 1 auto; text-transform: capitalize; }
.dnd-cr__badge {
  font-size: .75em; padding: 1px 6px; border-radius: 999px; opacity: .85;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.4));
}
.dnd-cr__off { opacity: .55; }
`

export interface ControlRoomHandle {
  root: HTMLElement
  apply(state: Sections): void
}

export function buildControlRoom(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): ControlRoomHandle {
  const root = ctx.dom.createElement('div', { class: 'dnd-cr' })

  const intro = ctx.dom.createElement('p', { class: 'dnd-cr__intro' })
  const size = ctx.dom.createElement('span', { class: 'dnd-cr__size' })

  const list = ctx.dom.createElement('div', { class: 'dnd-cr__list' })
  const systems = ctx.dom.createElement('div', { class: 'dnd-cr__list' })
  const systemsTitle = ctx.dom.createElement('p', { class: 'dnd-cr__intro' })
  systemsTitle.hidden = true

  // The wizard's output lands in this list, so its entry point belongs here.
  const add = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  add.textContent = '✨ Design a new Game System'
  add.title = 'Describe a mechanic and have it drafted as rules plus a tracked field'
  add.addEventListener('click', () => send({ type: 'wizard:open' }))

  root.append(intro, list, systemsTitle, systems, add)

  const row = (
    label: string,
    enabled: boolean,
    badge: string,
    onChange: (next: boolean) => void,
  ): HTMLElement => {
    const wrap = ctx.dom.createElement('label', {
      class: `dnd-cr__row${enabled ? '' : ' dnd-cr__off'}`,
    })
    const box = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
    box.checked = enabled
    box.addEventListener('change', () => onChange(box.checked))
    const name = ctx.dom.createElement('span', { class: 'dnd-cr__name' })
    name.textContent = label
    wrap.append(box, name)
    if (badge) {
      const chip = ctx.dom.createElement('span', { class: 'dnd-cr__badge' })
      chip.textContent = badge
      wrap.appendChild(chip)
    }
    return wrap
  }

  return {
    root,
    apply(state) {
      intro.textContent = 'These are the rules the narrator is given every turn — '
        + 'how to roll, how combat works, what a quest looks like. Turning one off '
        + 'removes it from the prompt. Currently '
      size.textContent = `${(state.size / 1000).toFixed(1)} KB`
      intro.appendChild(size)
      intro.appendChild(document.createTextNode('.'))

      list.textContent = ''
      for (const section of state.sections) {
        list.appendChild(row(
          section.label,
          section.enabled,
          section.kind === 'base' ? '' : 'custom',
          next => send({ type: 'sysprompt:toggle', tag: section.tag, enabled: next }),
        ))
      }

      systems.textContent = ''
      systemsTitle.hidden = state.systems.length === 0
      if (state.systems.length) {
        systemsTitle.textContent = 'Game Systems — a custom rule plus the field that tracks it.'
        for (const system of state.systems) {
          systems.appendChild(row(
            system.name,
            system.enabled,
            system.description ? '' : '',
            next => send({ type: 'sysprompt:system', id: system.id, enabled: next }),
          ))
        }
      }
    },
  }
}
