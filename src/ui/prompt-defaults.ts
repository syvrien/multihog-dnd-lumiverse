/**
 * prompt-defaults.ts — "an update changed these prompts".
 *
 * Shown once, on the first load after the shipped prompt text moves. Its whole
 * job is to make a decision possible, so the ordering is: what changed, whether
 * you have edited your copy, and only then the diff — collapsed, because nobody
 * reads 400 lines of prompt to answer a yes/no.
 *
 * Categories are checkboxes rather than one all-or-nothing button, and they
 * start **unticked for anything you have customised**. Ticked-by-default on a
 * category the user has edited is a dialog that throws work away for anyone who
 * presses the obvious button.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type Changed = Extract<ToFrontend, { type: 'prompts:changed' }>

interface ModalHandle {
  root: HTMLElement
  dismiss(): void
  onDismiss(handler: () => void): () => void
}

const BADGE_TEXT: Record<string, string> = {
  customized: 'you edited this',
  'matches new': 'already up to date',
  'matches old': 'unchanged from the old default',
  unknown: 'cannot tell',
}

export const PROMPT_DEFAULTS_CSS = `
.dnd-pd { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.dnd-pd__lede { line-height: 1.5; }
.dnd-pd__cat {
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  border-radius: 6px; padding: 10px;
}
.dnd-pd__head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dnd-pd__head label { display: flex; gap: 8px; align-items: center; font-weight: 600; }
.dnd-pd__badge {
  margin-left: auto; padding: 2px 8px; border-radius: 999px; font-size: .85em;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.4)); opacity: .85;
}
.dnd-pd__badge--customized {
  border-color: rgba(234,179,8,.55); color: rgba(240,200,110,.95); opacity: 1;
}
.dnd-pd__badge--new { border-color: rgba(34,197,94,.4); }
.dnd-pd__toggle {
  background: none; border: none; padding: 4px 0; cursor: pointer;
  font: inherit; color: inherit; opacity: .8; text-align: left;
}
.dnd-pd__diff {
  margin-top: 8px; max-height: 280px; overflow: auto; border-radius: 6px;
  background: rgba(128,128,128,.08); padding: 8px;
  font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.45;
}
.dnd-pd__block { margin-bottom: 10px; }
.dnd-pd__block-name { opacity: .75; margin-bottom: 3px; }
.dnd-pd__line { white-space: pre-wrap; overflow-wrap: anywhere; }
.dnd-pd__line--add { color: rgba(134,239,172,.95); }
.dnd-pd__line--del { color: rgba(248,160,160,.95); }
.dnd-pd__line--ctx { opacity: .6; }
.dnd-pd__actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.dnd-pd__button {
  min-height: 38px; padding: 0 14px; border-radius: 6px; cursor: pointer; font: inherit;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-surface, transparent);
  color: var(--lumiverse-text, inherit);
}
.dnd-pd__button--go {
  font-weight: 600;
  border: 2px solid rgba(216,120,72,.75); background: rgba(216,120,72,.2);
}
.dnd-pd__note { line-height: 1.5; opacity: .8; }
`

export interface PromptDefaultsHandle {
  close(): void
}

export function showPromptDefaults(
  ctx: SpindleFrontendContext,
  message: Changed,
  send: (message: ToBackend) => void,
  onClose: () => void,
): PromptDefaultsHandle | null {
  if (!ctx.ui.showModal || !message.changed.length) return null

  let handle: ModalHandle
  try {
    handle = ctx.ui.showModal({ title: 'Shipped prompts have changed', width: 620 }) as ModalHandle
  } catch (error) {
    console.warn('[DnD] could not open the prompt-defaults dialog:', error)
    return null
  }

  // Dismissing without choosing is "keep mine" — but it still has to count as
  // an answer, or the dialog reappears on every load until something is ticked.
  let answered = false
  handle.onDismiss(() => {
    if (!answered) send({ type: 'prompts:apply', categories: [] })
    onClose()
  })

  const wrap = document.createElement('div')
  wrap.className = 'dnd-pd'

  const lede = document.createElement('p')
  lede.className = 'dnd-pd__lede'
  lede.textContent = 'An update changed the prompt text this extension ships. '
    + 'Anything you edited yourself is left alone unless you tick it.'

  const list = document.createElement('div')
  list.className = 'dnd-pd'
  const boxes: Array<{ id: string; box: HTMLInputElement }> = []

  for (const category of message.changed) {
    const card = document.createElement('div')
    card.className = 'dnd-pd__cat'

    const head = document.createElement('div')
    head.className = 'dnd-pd__head'

    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    // Unticked where the user has edited: pressing the obvious button must not
    // silently discard their work.
    box.checked = category.badge !== 'customized'
    const name = document.createElement('span')
    name.textContent = category.label
    label.append(box, name)
    boxes.push({ id: category.id, box })

    const badge = document.createElement('span')
    badge.className = 'dnd-pd__badge'
    if (category.badge === 'customized') badge.classList.add('dnd-pd__badge--customized')
    if (category.badge === 'matches new') badge.classList.add('dnd-pd__badge--new')
    badge.textContent = BADGE_TEXT[category.badge] ?? category.badge

    head.append(label, badge)

    const totals = category.blocks.reduce(
      (sum, block) => ({ add: sum.add + block.additions, del: sum.del + block.deletions }),
      { add: 0, del: 0 },
    )
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'dnd-pd__toggle'
    const summary = `+${totals.add} / −${totals.del} across ${category.blocks.length} `
      + `block${category.blocks.length === 1 ? '' : 's'}`
    toggle.textContent = `Show what changed — ${summary}`

    const diff = document.createElement('div')
    diff.className = 'dnd-pd__diff'
    diff.hidden = true
    let built = false

    toggle.addEventListener('click', () => {
      // Built on first open: a category can carry several thousand diff lines,
      // and rendering all five up front makes the dialog land slowly.
      if (!built) {
        built = true
        for (const block of category.blocks) {
          const section = document.createElement('div')
          section.className = 'dnd-pd__block'
          const blockName = document.createElement('div')
          blockName.className = 'dnd-pd__block-name'
          blockName.textContent = block.label
          section.appendChild(blockName)
          for (const line of block.lines) {
            const row = document.createElement('div')
            row.className = `dnd-pd__line dnd-pd__line--${line.type}`
            row.textContent = `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.text}`
            section.appendChild(row)
          }
          if (block.truncated) {
            const more = document.createElement('div')
            more.className = 'dnd-pd__line dnd-pd__line--ctx'
            more.textContent = '… diff truncated'
            section.appendChild(more)
          }
          diff.appendChild(section)
        }
      }
      diff.hidden = !diff.hidden
      toggle.textContent = `${diff.hidden ? 'Show' : 'Hide'} what changed — ${summary}`
    })

    card.append(head, toggle, diff)
    list.appendChild(card)
  }

  const note = document.createElement('p')
  note.className = 'dnd-pd__note'
  note.textContent = 'To keep a copy of your current setup before updating, save '
    + 'it as a Game Cartridge first — the Cartridges tab does that, and this '
    + 'dialog will still be here when you come back.'

  const actions = document.createElement('div')
  actions.className = 'dnd-pd__actions'

  const keep = document.createElement('button')
  keep.type = 'button'
  keep.className = 'dnd-pd__button'
  keep.textContent = 'Keep mine'
  keep.addEventListener('click', () => {
    answered = true
    send({ type: 'prompts:apply', categories: [] })
    handle.dismiss()
  })

  const update = document.createElement('button')
  update.type = 'button'
  update.className = 'dnd-pd__button dnd-pd__button--go'
  update.textContent = 'Update ticked'
  update.addEventListener('click', () => {
    answered = true
    send({
      type: 'prompts:apply',
      categories: boxes.filter(entry => entry.box.checked).map(entry => entry.id),
    })
    handle.dismiss()
  })

  actions.append(keep, update)
  wrap.append(lede, list, note, actions)
  handle.root.appendChild(wrap)

  return {
    close(): void {
      answered = true
      handle.dismiss()
    },
  }
}
