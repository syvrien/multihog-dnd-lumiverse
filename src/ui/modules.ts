/**
 * modules.ts — the Modular Repertoire editor.
 *
 * One block per record type the Lorebook Agent can write: a switch, the field
 * layout, and the rule that decides when it writes one.
 *
 * The rule is the part worth exposing. "ONLY record a quest if the player
 * unambiguously begins to pursue one" is the difference between a quest log and
 * a list of every rumour in the tavern, and it is one editable sentence.
 *
 * Upstream renders the field layout as draggable chips. Here it is the same
 * pipe-separated string the engine actually stores — less pretty, and it does
 * not pretend a reordering gesture exists that the port has not built.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type State = Extract<ToFrontend, { type: 'modules:state' }>

export const MODULES_CSS = `
.dnd-mod { display: flex; flex-direction: column; gap: 12px; }
.dnd-mod__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-mod__item {
  display: flex; flex-direction: column; gap: 6px; padding: 10px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.28)); border-radius: 8px;
}
.dnd-mod__head { display: flex; align-items: center; gap: 8px; }
.dnd-mod__name { flex: 1 1 auto; font-weight: 600; }
.dnd-mod__tag {
  font-family: ui-monospace, Consolas, monospace; font-size: .85em; opacity: .75;
}
.dnd-mod__reset {
  font: inherit; font-size: .85em; cursor: pointer; padding: 2px 8px; border-radius: 5px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.4));
  background: transparent; color: var(--lumiverse-text-dim, rgba(160,160,160,.95));
}
.dnd-mod__reset[hidden] { display: none; }
.dnd-mod__label { font-size: .85em; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-mod__format, .dnd-mod__rule {
  width: 100%; padding: 7px 9px; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-mod__format { font-family: ui-monospace, Consolas, monospace; font-size: 14px; }
.dnd-mod__rule { min-height: 84px; resize: vertical; line-height: 1.45; }
.dnd-mod__item--off { opacity: .6; }
`

/** Friendlier than the raw ids the engine uses. */
const NAMES: Record<string, string> = {
  npc: 'People',
  loc: 'Places',
  fac: 'Factions',
  quest: 'Quests',
  event: 'Events',
  world: 'World reports',
}

export interface ModulesHandle {
  root: HTMLElement
  apply(state: State): void
}

export function buildModulesEditor(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): ModulesHandle {
  const root = ctx.dom.createElement('div', { class: 'dnd-mod' })

  const intro = ctx.dom.createElement('p', { class: 'dnd-mod__intro' })
  intro.textContent = 'What the agent is allowed to record, and the rule it '
    + 'follows for each. These rules are most of how the agent behaves — '
    + 'tightening one is usually better than switching the type off.'
  root.appendChild(intro)

  const list = ctx.dom.createElement('div', { class: 'dnd-mod' })
  root.appendChild(list)

  return {
    root,
    apply(state) {
      list.textContent = ''
      for (const module of state.modules) {
        const item = ctx.dom.createElement('div', {
          class: `dnd-mod__item${module.enabled ? '' : ' dnd-mod__item--off'}`,
        })

        const head = ctx.dom.createElement('div', { class: 'dnd-mod__head' })
        const box = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
        box.checked = module.enabled
        box.addEventListener('change', () => {
          send({ type: 'modules:patch', id: module.id, enabled: box.checked })
        })
        const name = ctx.dom.createElement('span', { class: 'dnd-mod__name' })
        name.textContent = NAMES[module.id] ?? module.id
        const tag = ctx.dom.createElement('span', { class: 'dnd-mod__tag' })
        tag.textContent = `[${module.tag}]`

        const reset = ctx.dom.createElement('button', {
          class: 'dnd-mod__reset', type: 'button',
        }) as HTMLButtonElement
        reset.textContent = 'Reset'
        reset.title = 'Restore the shipped rule and layout'
        // Only offered once something has actually been changed.
        reset.hidden = module.isDefault
        reset.addEventListener('click', () => {
          send({ type: 'modules:reset', id: module.id })
        })

        head.append(box, name, tag, reset)

        const formatLabel = ctx.dom.createElement('div', { class: 'dnd-mod__label' })
        formatLabel.textContent = 'Fields, in order'
        const format = ctx.dom.createElement('input', {
          class: 'dnd-mod__format', type: 'text',
        }) as HTMLInputElement
        format.value = module.format
        format.addEventListener('change', () => {
          send({ type: 'modules:patch', id: module.id, format: format.value })
        })

        const ruleLabel = ctx.dom.createElement('div', { class: 'dnd-mod__label' })
        ruleLabel.textContent = 'When to record one'
        const rule = ctx.dom.createElement('textarea', {
          class: 'dnd-mod__rule',
        }) as HTMLTextAreaElement
        rule.value = module.instruction
        rule.addEventListener('change', () => {
          send({ type: 'modules:patch', id: module.id, instruction: rule.value })
        })

        item.append(head, formatLabel, format, ruleLabel, rule)
        list.appendChild(item)
      }
    },
  }
}
