/**
 * blocks.ts — the tracker's cards, and the schema behind character cards.
 *
 * Upstream splits this across a drag-sortable order list, a modal custom-module
 * editor with a live preview HUD, and two more modals for the NPC and PC
 * section schemas. All of it is jQuery against SillyTavern's DOM, so it is
 * rebuilt rather than ported.
 *
 * What survives the rebuild is the shape of the decision: one list of cards you
 * can reorder and switch off, with the custom ones expanding in place to their
 * own fields. Upstream's live preview HUD does not come across — it is a
 * draggable floating window rendering sandbox text through the panel renderer,
 * and the honest substitute is the panel itself, which repaints on every save
 * anyway.
 *
 * **Switching a card off is not cosmetic**, and the copy says so: the tracker's
 * instruction is built from the enabled set, so an off card is also a thing the
 * model stops being asked about.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type BlocksState = Extract<ToFrontend, { type: 'blocks:state' }>
type SectionsState = Extract<ToFrontend, { type: 'sections:state' }>

export const BLOCKS_CSS = `
.dnd-blk { display: flex; flex-direction: column; gap: 10px; }
.dnd-blk__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-blk__list { display: flex; flex-direction: column; gap: 4px; }
.dnd-blk__row {
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
  padding: 5px 8px; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.28));
}
.dnd-blk__row--off { opacity: .55; }
.dnd-blk__name { flex: 1 1 auto; min-width: 0; }
.dnd-blk__kind { opacity: .55; font-size: .82em; }
.dnd-blk__move {
  border: none; background: transparent; cursor: pointer; font: inherit;
  color: inherit; opacity: .6; padding: 0 3px; line-height: 1;
}
.dnd-blk__move:hover:not(:disabled) { opacity: 1; }
.dnd-blk__move:disabled { opacity: .2; cursor: default; }
.dnd-blk__edit {
  min-height: 28px; padding: 0 9px; border-radius: 6px; cursor: pointer; font: inherit;
  font-size: .9em;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-surface, transparent);
  color: var(--lumiverse-text, inherit);
}
.dnd-blk__form {
  display: flex; flex-direction: column; gap: 6px; flex: 1 1 100%;
  margin-top: 6px; padding-top: 8px;
  border-top: 1px solid var(--lumiverse-border, rgba(128,128,128,.2));
}
.dnd-blk__fields { display: flex; gap: 6px; flex-wrap: wrap; }
.dnd-blk input, .dnd-blk textarea, .dnd-blk select {
  padding: 6px 8px; border-radius: 6px; min-height: 32px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-blk__icon { width: 52px; text-align: center; }
.dnd-blk__tag { width: 120px; font-family: ui-monospace, Consolas, monospace; }
.dnd-blk__label { flex: 1 1 140px; min-width: 0; }
.dnd-blk__num { width: 74px; }
.dnd-blk textarea {
  width: 100%; min-height: 110px; resize: vertical; font-size: 14px; line-height: 1.5;
}
.dnd-blk__hint { line-height: 1.45; opacity: .7; font-size: .9em; }
.dnd-blk__note { line-height: 1.45; color: rgba(216,160,72,.95); }
.dnd-blk__actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dnd-blk__danger { color: rgba(224,128,96,.95); }
.dnd-blk__tabs { display: flex; gap: 6px; }
.dnd-blk__tab[aria-pressed="true"] { font-weight: 600; border-color: rgba(216,120,72,.75); }
.dnd-blk__sec { display: flex; flex-direction: column; gap: 4px; }
`

export interface BlocksHandle {
  root: HTMLElement
  applyBlocks(state: BlocksState): void
  applySections(state: SectionsState): void
}

export function buildBlocks(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): BlocksHandle {
  const root = ctx.dom.createElement('div', { class: 'dnd-blk' })

  // ── the cards ───────────────────────────────────────────────────────────
  const intro = ctx.dom.createElement('p', { class: 'dnd-blk__intro' })
  intro.textContent = 'The cards the tracker keeps, in the order the panel draws '
    + 'them. Switching one off also stops the tracker being asked to track it, '
    + 'which is usually what you want — an unwatched card costs tokens every turn.'

  const list = ctx.dom.createElement('div', { class: 'dnd-blk__list' })
  const note = ctx.dom.createElement('div', { class: 'dnd-blk__note' })
  note.hidden = true

  const addRow = ctx.dom.createElement('div', { class: 'dnd-blk__actions' })
  const addButton = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  addButton.textContent = 'Add a module'
  addButton.title = 'Track something the shipped modules do not cover'
  addButton.addEventListener('click', () => {
    // Created straight away rather than behind a blank form: the row that
    // appears is the editor, and an unsaved form is a thing to lose.
    send({
      type: 'blocks:save',
      tag: `CUSTOM_${Date.now().toString(36).slice(-4).toUpperCase()}`,
      label: 'New module',
      icon: '📄',
    })
  })
  addRow.appendChild(addButton)

  /** Tags whose editor is expanded, kept across repaints. */
  const open = new Set<string>()

  // ── card schemas ────────────────────────────────────────────────────────
  const secIntro = ctx.dom.createElement('p', { class: 'dnd-blk__intro' })
  secIntro.textContent = 'What goes in a character card. Each section’s text is '
    + 'the instruction the agent follows for it, not a label — so this is where '
    + 'you teach it about a setting the shipped schema does not cover.'

  const tabs = ctx.dom.createElement('div', { class: 'dnd-blk__tabs' })
  let target: 'npc' | 'pc' = 'npc'
  const tabButtons: HTMLButtonElement[] = []
  for (const option of [
    { value: 'npc' as const, label: 'NPC cards' },
    { value: 'pc' as const, label: 'Player card' },
  ]) {
    const button = ctx.dom.createElement('button', {
      class: 'dnd-blk__edit dnd-blk__tab', type: 'button',
    }) as HTMLButtonElement
    button.textContent = option.label
    button.setAttribute('aria-pressed', String(option.value === target))
    button.addEventListener('click', () => {
      target = option.value
      for (const other of tabButtons) {
        other.setAttribute('aria-pressed', String(other === button))
      }
      send({ type: 'sections:read', target })
    })
    tabButtons.push(button)
    tabs.appendChild(button)
  }

  const sectionList = ctx.dom.createElement('div', { class: 'dnd-blk__sec' })
  const secNote = ctx.dom.createElement('div', { class: 'dnd-blk__note' })
  secNote.hidden = true

  const secActions = ctx.dom.createElement('div', { class: 'dnd-blk__actions' })
  const newSection = ctx.dom.createElement('input', {
    class: 'dnd-blk__label', type: 'text', placeholder: 'New section name',
  }) as HTMLInputElement
  const addSection = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  addSection.textContent = 'Add section'
  addSection.addEventListener('click', () => {
    if (!newSection.value.trim()) { newSection.focus(); return }
    send({ type: 'sections:add', target, name: newSection.value.trim() })
    newSection.value = ''
  })
  const resetSections = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  resetSections.textContent = 'Reset to shipped'
  resetSections.addEventListener('click', () => {
    const ok = globalThis.confirm?.(
      'Put back the shipped card sections? Your edits to them are lost.',
    )
    if (ok === false) return
    send({ type: 'sections:reset', target })
  })
  secActions.append(newSection, addSection, resetSections)

  root.append(intro, list, addRow, note, secIntro, tabs, sectionList, secActions, secNote)

  /** The expanded editor for one custom module. */
  const buildForm = (block: BlocksState['blocks'][number]): HTMLElement => {
    const form = ctx.dom.createElement('div', { class: 'dnd-blk__form' })

    const fields = ctx.dom.createElement('div', { class: 'dnd-blk__fields' })
    const icon = ctx.dom.createElement('input', {
      class: 'dnd-blk__icon', type: 'text', title: 'Icon',
    }) as HTMLInputElement
    icon.value = block.icon
    const tag = ctx.dom.createElement('input', {
      class: 'dnd-blk__tag', type: 'text', title: 'Tag — the model writes [TAG] blocks',
    }) as HTMLInputElement
    tag.value = block.tag
    const label = ctx.dom.createElement('input', {
      class: 'dnd-blk__label', type: 'text', placeholder: 'Display label',
    }) as HTMLInputElement
    label.value = block.label
    const pageSize = ctx.dom.createElement('input', {
      class: 'dnd-blk__num', type: 'number', min: '1', max: '99',
      title: 'Rows before pagination',
    }) as HTMLInputElement
    pageSize.value = String(block.pageSize)
    fields.append(icon, tag, label, pageSize)

    const prompt = ctx.dom.createElement('textarea', {
      placeholder: 'What should the tracker record here, and in what format? '
        + 'Include a worked example — it is the format the model copies.',
    }) as HTMLTextAreaElement
    prompt.value = block.prompt ?? ''

    const hint = ctx.dom.createElement('div', { class: 'dnd-blk__hint' })
    hint.textContent = 'Renaming the tag follows it everywhere it is referenced — '
      + 'card order, display groups, and any Game System that owns it.'

    const actions = ctx.dom.createElement('div', { class: 'dnd-blk__actions' })
    const save = ctx.dom.createElement('button', {
      class: 'dnd-panel__button', type: 'button',
    }) as HTMLButtonElement
    save.textContent = 'Save module'
    save.addEventListener('click', () => {
      send({
        type: 'blocks:save',
        originalTag: block.tag,
        tag: tag.value,
        icon: icon.value,
        label: label.value,
        prompt: prompt.value,
        template: block.template ?? '',
        pageSize: Number(pageSize.value) || undefined,
      })
    })
    const remove = ctx.dom.createElement('button', {
      class: 'dnd-panel__button dnd-blk__danger', type: 'button',
    }) as HTMLButtonElement
    remove.textContent = 'Delete'
    remove.addEventListener('click', () => {
      const ok = globalThis.confirm?.(
        `Delete the ${block.label} module? Anything it tracked stops being tracked.`,
      )
      if (ok === false) return
      open.delete(block.tag)
      send({ type: 'blocks:delete', tag: block.tag })
    })
    actions.append(save, remove)

    form.append(fields, prompt, hint, actions)
    return form
  }

  /** The expanded editor for a built-in module: its instruction, and a reset. */
  const buildStockForm = (block: BlocksState['blocks'][number]): HTMLElement => {
    const form = ctx.dom.createElement('div', { class: 'dnd-blk__form' })

    const prompt = ctx.dom.createElement('textarea', {
      placeholder: 'What this module asks the tracker to record.',
    }) as HTMLTextAreaElement
    prompt.value = block.stockPrompt ?? ''

    const hint = ctx.dom.createElement('div', { class: 'dnd-blk__hint' })
    hint.textContent = block.tag === 'QUESTS'
      // Worth saying rather than letting someone find out: the quests text is
      // regenerated from the shipped default whenever a quest toggle moves.
      ? 'The quest deadline and frustration toggles regenerate this text from '
        + 'the shipped version, so an edit here lasts until one of them changes.'
      : 'This is the text the tracker is given for this module, not a copy of it.'

    const actions = ctx.dom.createElement('div', { class: 'dnd-blk__actions' })
    const save = ctx.dom.createElement('button', {
      class: 'dnd-panel__button', type: 'button',
    }) as HTMLButtonElement
    save.textContent = 'Save instruction'
    save.addEventListener('click', () =>
      send({ type: 'blocks:prompt', tag: block.tag, text: prompt.value }))

    const reset = ctx.dom.createElement('button', {
      class: 'dnd-panel__button', type: 'button',
    }) as HTMLButtonElement
    reset.textContent = 'Reset to shipped'
    reset.hidden = block.stockIsDefault !== false
    reset.addEventListener('click', () =>
      send({ type: 'blocks:prompt-reset', tag: block.tag }))

    actions.append(save, reset)
    form.append(prompt, hint, actions)
    return form
  }

  return {
    root,
    applyBlocks(state) {
      note.hidden = !state.reason
      if (state.reason) note.textContent = state.reason

      list.textContent = ''
      for (const [index, block] of state.blocks.entries()) {
        const row = ctx.dom.createElement('div', { class: 'dnd-blk__row' })
        if (!block.enabled) row.classList.add('dnd-blk__row--off')

        const on = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
        on.checked = block.enabled
        on.title = block.enabled
          ? 'Tracked and drawn. Switching off also stops the model being asked.'
          : 'Not tracked and not drawn.'
        on.addEventListener('change', () =>
          send({ type: 'blocks:enable', tag: block.tag, enabled: on.checked }))

        const name = ctx.dom.createElement('span', { class: 'dnd-blk__name' })
        name.textContent = `${block.icon} ${block.label}`

        const kind = ctx.dom.createElement('span', { class: 'dnd-blk__kind' })
        kind.textContent = block.kind === 'stock'
          ? (block.stockIsDefault === false ? 'built in · edited' : 'built in')
          : block.kind

        const up = ctx.dom.createElement('button', {
          class: 'dnd-blk__move', type: 'button', title: 'Draw this earlier',
        }) as HTMLButtonElement
        up.textContent = '↑'
        up.disabled = index === 0
        up.addEventListener('click', () =>
          send({ type: 'blocks:move', tag: block.tag, direction: 'up' }))

        const down = ctx.dom.createElement('button', {
          class: 'dnd-blk__move', type: 'button', title: 'Draw this later',
        }) as HTMLButtonElement
        down.textContent = '↓'
        down.disabled = index === state.blocks.length - 1
        down.addEventListener('click', () =>
          send({ type: 'blocks:move', tag: block.tag, direction: 'down' }))

        row.append(on, name, kind, up, down)

        // Built-in modules have one editable thing: the instruction they give
        // the tracker. `buildModulesInstructionText()` reads `stockPrompts` in
        // preference to the shipped text, so this is genuinely what is sent.
        {
          const edit = ctx.dom.createElement('button', {
            class: 'dnd-blk__edit', type: 'button',
          }) as HTMLButtonElement
          const expanded = open.has(block.tag)
          edit.textContent = expanded ? 'Close' : 'Edit'
          edit.addEventListener('click', () => {
            if (open.has(block.tag)) open.delete(block.tag)
            else open.add(block.tag)
            send({ type: 'blocks:read' })
          })
          row.appendChild(edit)
          if (expanded) {
            row.appendChild(block.kind === 'stock'
              ? buildStockForm(block)
              : buildForm(block))
          }
        }

        list.appendChild(row)
      }
    },
    applySections(state) {
      target = state.target
      for (const [index, button] of tabButtons.entries()) {
        button.setAttribute('aria-pressed', String(
          (index === 0 ? 'npc' : 'pc') === state.target))
      }
      secNote.hidden = !state.reason
      if (state.reason) secNote.textContent = state.reason
      resetSections.hidden = state.isDefault

      sectionList.textContent = ''
      for (const [index, section] of state.sections.entries()) {
        const row = ctx.dom.createElement('div', { class: 'dnd-blk__row' })

        const icon = ctx.dom.createElement('input', {
          class: 'dnd-blk__icon', type: 'text', title: 'Icon',
        }) as HTMLInputElement
        icon.value = section.icon
        const name = ctx.dom.createElement('input', {
          class: 'dnd-blk__label', type: 'text',
        }) as HTMLInputElement
        name.value = section.name

        const up = ctx.dom.createElement('button', {
          class: 'dnd-blk__move', type: 'button', title: 'Earlier on the card',
        }) as HTMLButtonElement
        up.textContent = '↑'
        up.disabled = index === 0
        up.addEventListener('click', () =>
          send({ type: 'sections:move', target: state.target, id: section.id, direction: 'up' }))
        const down = ctx.dom.createElement('button', {
          class: 'dnd-blk__move', type: 'button', title: 'Later on the card',
        }) as HTMLButtonElement
        down.textContent = '↓'
        down.disabled = index === state.sections.length - 1
        down.addEventListener('click', () =>
          send({ type: 'sections:move', target: state.target, id: section.id, direction: 'down' }))

        const remove = ctx.dom.createElement('button', {
          class: 'dnd-blk__move dnd-blk__danger', type: 'button', title: 'Remove this section',
        }) as HTMLButtonElement
        remove.textContent = '✕'
        remove.addEventListener('click', () =>
          send({ type: 'sections:delete', target: state.target, id: section.id }))

        const description = ctx.dom.createElement('textarea', {
          placeholder: 'What the agent should put in this section — and what it should not.',
        }) as HTMLTextAreaElement
        description.value = section.description

        // Committed on blur rather than per keystroke: each edit rebuilds the
        // agent's NPC instruction and writes settings.
        const commit = (): void => {
          if (name.value.trim() === section.name
            && description.value === section.description
            && icon.value.trim() === section.icon) return
          send({
            type: 'sections:update',
            target: state.target,
            id: section.id,
            name: name.value,
            description: description.value,
            icon: icon.value,
          })
        }
        for (const field of [icon, name, description]) field.addEventListener('blur', commit)
        name.addEventListener('keydown', event => {
          if ((event as KeyboardEvent).key === 'Enter') name.blur()
        })

        row.append(icon, name, up, down, remove, description)
        sectionList.appendChild(row)
      }
    },
  }
}
