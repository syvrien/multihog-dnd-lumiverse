/**
 * appearance.ts — the panel's palette, and drawn portraits.
 *
 * Both live under General & Visuals because both are about how the tracker
 * looks rather than how the game plays.
 *
 * The theme is applied by writing the `--rt-custom-*` variables into a style
 * block. The engine's stylesheet already reads them, so nothing else has to
 * know a theme exists.
 *
 * Undo is prominent on purpose: a bad palette can make the panel unreadable,
 * and the button that fixes that must not be one you have to read the panel to
 * find.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type ThemeState = Extract<ToFrontend, { type: 'theme:state' }>
type ThemeDraft = Extract<ToFrontend, { type: 'theme:draft' }>
type GenState = Extract<ToFrontend, { type: 'portrait:gen-state' }>
type GenResult = Extract<ToFrontend, { type: 'portrait:gen-result' }>
type GroupsState = Extract<ToFrontend, { type: 'groups:state' }>

export const APPEARANCE_CSS = `
.dnd-app { display: flex; flex-direction: column; gap: 10px; }
.dnd-app__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-app__row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dnd-app__input {
  flex: 1 1 180px; min-width: 0; padding: 7px 9px; border-radius: 6px; min-height: 34px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-app__swatches { display: flex; flex-wrap: wrap; gap: 4px; }
.dnd-app__swatch {
  width: 22px; height: 22px; border-radius: 4px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.4));
}
.dnd-app__note { line-height: 1.45; color: rgba(216,160,72,.95); }
.dnd-app__prompt {
  width: 100%; min-height: 96px; padding: 8px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  font: inherit; font-size: 15px; line-height: 1.5;
}
.dnd-app__preview { max-width: 220px; border-radius: 8px; }
.dnd-app__group {
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
  padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.3));
}
.dnd-app__group--off { opacity: .55; }
.dnd-app__group-name { flex: 1 1 140px; font-weight: 600; }
.dnd-app__group-members {
  flex: 1 1 100%; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px;
}
.dnd-app__member {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 2px 4px 2px 8px; border-radius: 999px; font-size: .85em; opacity: .85;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
}
.dnd-app__member button {
  border: none; background: transparent; cursor: pointer; font: inherit;
  color: inherit; opacity: .6; padding: 0 2px; line-height: 1;
}
.dnd-app__member button:hover:not(:disabled) { opacity: 1; }
.dnd-app__member button:disabled { opacity: .2; cursor: default; }
.dnd-app__mods { display: flex; flex-direction: column; gap: 4px; }
.dnd-app__mod { display: flex; gap: 8px; align-items: center; }
.dnd-app__mod-name { flex: 1 1 auto; min-width: 0; }
.dnd-app__mod-kind { opacity: .6; font-size: .85em; }
.dnd-app__select {
  padding: 5px 8px; border-radius: 6px; min-height: 32px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit); font: inherit;
}
`

export interface AppearanceHandle {
  root: HTMLElement
  applyTheme(state: ThemeState): void
  applyDraft(draft: ThemeDraft): void
  applyGenState(state: GenState): void
  applyGenResult(result: GenResult): void
  applyGroups(state: GroupsState): void
  dispose(): void
}

export function buildAppearance(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): AppearanceHandle {
  const root = ctx.dom.createElement('div', { class: 'dnd-app' })

  // ── theme ───────────────────────────────────────────────────────────────
  let removeThemeStyle: (() => void) | null = null
  /** The palette waiting to be kept or discarded. */
  let pending: Record<string, string> | null = null

  const themeIntro = ctx.dom.createElement('p', { class: 'dnd-app__intro' })
  themeIntro.textContent = 'Describe how the tracker panel should look and a '
    + 'palette is mixed for it. Refining works from what is on screen.'

  const describeRow = ctx.dom.createElement('div', { class: 'dnd-app__row' })
  const describe = ctx.dom.createElement('input', {
    class: 'dnd-app__input', type: 'text',
    placeholder: 'e.g. a haunted crypt, candlelight on wet stone',
  }) as HTMLInputElement
  const make = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  make.textContent = 'Mix'
  make.addEventListener('click', () => {
    if (!describe.value.trim()) { describe.focus(); return }
    send({ type: 'theme:generate', description: describe.value.trim(), refine: false })
  })
  const refine = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  refine.textContent = 'Refine'
  refine.title = 'Change the palette that is on screen'
  refine.addEventListener('click', () => {
    if (!describe.value.trim()) { describe.focus(); return }
    send({ type: 'theme:generate', description: describe.value.trim(), refine: true })
  })
  describeRow.append(describe, make, refine)

  const swatches = ctx.dom.createElement('div', { class: 'dnd-app__swatches' })
  const themeNote = ctx.dom.createElement('div', { class: 'dnd-app__note' })
  themeNote.hidden = true

  const themeRow = ctx.dom.createElement('div', { class: 'dnd-app__row' })
  const saveName = ctx.dom.createElement('input', {
    class: 'dnd-app__input', type: 'text', placeholder: 'Save palette as…',
  }) as HTMLInputElement
  const saveTheme = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  saveTheme.textContent = 'Save'
  saveTheme.addEventListener('click', () => {
    const name = saveName.value.trim()
    if (!name) { saveName.focus(); return }
    saveName.value = ''
    send({ type: 'theme:save', name })
  })
  const savedPick = ctx.dom.createElement('select', { class: 'dnd-app__input' }) as HTMLSelectElement
  savedPick.addEventListener('change', () => {
    if (savedPick.value) send({ type: 'theme:load', name: savedPick.value })
  })
  const undo = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  undo.textContent = 'Undo'
  undo.addEventListener('click', () => send({ type: 'theme:undo' }))
  const reset = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  reset.textContent = 'Default look'
  reset.addEventListener('click', () => send({ type: 'theme:apply', vars: null }))
  themeRow.append(saveName, saveTheme, savedPick, undo, reset)

  // ── portraits ───────────────────────────────────────────────────────────
  const portraitIntro = ctx.dom.createElement('p', { class: 'dnd-app__intro' })
  const portraitRow = ctx.dom.createElement('div', { class: 'dnd-app__row' })
  const who = ctx.dom.createElement('select', { class: 'dnd-app__input' }) as HTMLSelectElement
  const writePrompt = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  writePrompt.textContent = 'Describe them'
  writePrompt.title = 'Write the prompt without drawing anything'
  writePrompt.addEventListener('click', () => {
    if (who.value) send({ type: 'portrait:describe', entity: who.value })
  })
  const draw = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  draw.textContent = 'Draw'
  draw.addEventListener('click', () => {
    if (!who.value) return
    send({ type: 'portrait:generate', entity: who.value, prompt: promptBox.value.trim() })
  })
  portraitRow.append(who, writePrompt, draw)

  const promptBox = ctx.dom.createElement('textarea', {
    class: 'dnd-app__prompt',
    placeholder: 'The prompt appears here. Edit it before drawing if you like.',
  }) as HTMLTextAreaElement
  const preview = ctx.dom.createElement('img', { class: 'dnd-app__preview' }) as HTMLImageElement
  preview.alt = ''
  preview.hidden = true
  const portraitNote = ctx.dom.createElement('div', { class: 'dnd-app__note' })
  portraitNote.hidden = true

  // -- display groups -----------------------------------------------------
  // Presentation only, which is why it sits here with the palette rather than
  // anywhere near the Game Systems that decide what is tracked.
  const groupsIntro = ctx.dom.createElement('p', { class: 'dnd-app__intro' })
  groupsIntro.textContent = 'Fold several tracker cards into one - hunger, thirst '
    + 'and temperature under "Survival", say. This changes the panel only: the '
    + 'narrator is told exactly the same things either way.'

  const groupsToggleRow = ctx.dom.createElement('label', { class: 'dnd-app__row' })
  const groupsOn = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
  groupsOn.addEventListener('change', () =>
    send({ type: 'groups:enable', enabled: groupsOn.checked }))
  const groupsOnText = ctx.dom.createElement('span')
  groupsOnText.textContent = 'Group cards in the panel'
  groupsToggleRow.append(groupsOn, groupsOnText)

  const gapsRow = ctx.dom.createElement('label', { class: 'dnd-app__row' })
  const gapsOn = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
  gapsOn.addEventListener('change', () =>
    send({ type: 'groups:gaps', showGaps: gapsOn.checked }))
  const gapsText = ctx.dom.createElement('span')
  gapsText.textContent = 'Show a placeholder for grouped cards with no data yet'
  gapsRow.append(gapsOn, gapsText)

  const groupList = ctx.dom.createElement('div', { class: 'dnd-app__mods' })

  const addRow = ctx.dom.createElement('div', { class: 'dnd-app__row' })
  const newName = ctx.dom.createElement('input', {
    class: 'dnd-app__input', type: 'text', placeholder: 'New group name',
  }) as HTMLInputElement
  // A group needs a member from the start: the engine drops empty ones, so
  // creating one and asking you to fill it would delete it on the next save.
  const newMember = ctx.dom.createElement('select', { class: 'dnd-app__select' }) as HTMLSelectElement
  const addGroup = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  addGroup.textContent = 'Add group'
  addGroup.addEventListener('click', () => {
    if (!newName.value.trim()) { newName.focus(); return }
    send({ type: 'groups:add', name: newName.value.trim(), member: newMember.value })
    newName.value = ''
  })
  addRow.append(newName, newMember, addGroup)

  const moduleList = ctx.dom.createElement('div', { class: 'dnd-app__mods' })
  const groupsNote = ctx.dom.createElement('div', { class: 'dnd-app__note' })
  groupsNote.hidden = true

  root.append(
    themeIntro, describeRow, swatches, themeNote, themeRow,
    portraitIntro, portraitRow, promptBox, preview, portraitNote,
    groupsIntro, groupsToggleRow, gapsRow, groupList, addRow, moduleList, groupsNote,
  )

  return {
    root,
    applyTheme(state) {
      // Write the variables into a style block; the engine's stylesheet does
      // the rest. Replaced wholesale so removing a theme actually removes it.
      removeThemeStyle?.()
      removeThemeStyle = null
      if (state.active && Object.keys(state.active).length) {
        const css = `:root {\n${Object.entries(state.active)
          .map(([name, value]) => `  ${name}: ${value} !important;`)
          .join('\n')}\n}`
        removeThemeStyle = ctx.dom.addStyle(css)
      }

      swatches.textContent = ''
      for (const value of Object.values(state.active ?? {})) {
        // Only the colours; fonts and blurs are not swatchable.
        if (!/^#|^rgb|^hsl/i.test(value)) continue
        const chip = ctx.dom.createElement('span', { class: 'dnd-app__swatch' })
        chip.style.background = value
        swatches.appendChild(chip)
      }

      undo.disabled = !state.canUndo
      const previous = savedPick.value
      savedPick.textContent = ''
      const none = ctx.dom.createElement('option') as HTMLOptionElement
      none.value = ''
      none.textContent = state.saved.length ? 'Load a saved palette…' : 'No saved palettes'
      savedPick.appendChild(none)
      for (const name of state.saved) {
        const option = ctx.dom.createElement('option') as HTMLOptionElement
        option.value = name
        option.textContent = name
        savedPick.appendChild(option)
      }
      savedPick.value = state.saved.includes(previous) ? previous : ''
      pending = null
    },
    applyDraft(draft) {
      if (!draft.ok || !draft.vars) {
        themeNote.hidden = false
        themeNote.textContent = draft.reason
          ? `No palette: ${draft.reason}`
          : 'No palette came back.'
        return
      }
      themeNote.hidden = true
      pending = draft.vars
      // Applied straight away — a palette is judged by looking at it, and Undo
      // is right there.
      send({ type: 'theme:apply', vars: pending })
    },
    applyGenState(state) {
      who.textContent = ''
      draw.disabled = !state.available
      writePrompt.disabled = !state.targets.length

      portraitIntro.textContent = state.available
        ? 'Draw a portrait from what the tracker knows about them.'
        : `Portrait drawing is unavailable — ${state.reason ?? 'unknown reason'}. `
          + 'You can still set one by hand from a card in the tracker.'

      if (!state.targets.length) {
        const none = ctx.dom.createElement('option') as HTMLOptionElement
        none.textContent = 'Nobody on the tracker yet'
        who.appendChild(none)
        return
      }
      for (const name of state.targets) {
        const option = ctx.dom.createElement('option') as HTMLOptionElement
        option.value = name
        option.textContent = name
        who.appendChild(option)
      }
    },
    applyGenResult(result) {
      if (!result.ok) {
        portraitNote.hidden = false
        portraitNote.textContent = `${result.entity}: ${result.reason ?? 'unknown error'}`
        if (result.prompt) promptBox.value = result.prompt
        return
      }
      portraitNote.hidden = true
      if (result.prompt) promptBox.value = result.prompt
      if (result.promptOnly) return
      if (result.url) {
        preview.src = result.url
        preview.hidden = false
      }
    },
    applyGroups(state) {
      groupsOn.checked = state.enabled
      gapsOn.checked = state.showGaps
      gapsRow.hidden = !state.enabled

      groupsNote.hidden = !state.reason
      if (state.reason) groupsNote.textContent = state.reason

      groupList.textContent = ''
      for (const group of state.groups) {
        const row = ctx.dom.createElement('div', { class: 'dnd-app__group' })
        if (!group.enabled) row.classList.add('dnd-app__group--off')

        const on = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
        on.checked = group.enabled
        on.title = 'Fold this group, or leave its cards separate'
        on.addEventListener('change', () =>
          send({ type: 'groups:toggle', id: group.id, enabled: on.checked }))

        // Editable in place: renaming is the commonest change to a group, and a
        // dialog for it would be heavier than the thing it edits.
        const name = ctx.dom.createElement('input', {
          class: 'dnd-app__input dnd-app__group-name', type: 'text',
        }) as HTMLInputElement
        name.value = `${group.icon} ${group.name}`.trim()
        const commitName = (): void => {
          const raw = name.value.trim()
          if (!raw) { name.value = `${group.icon} ${group.name}`.trim(); return }
          // A leading non-letter run is the icon; the rest is the name.
          const match = /^(\P{L}\S*)\s+(.*)$/u.exec(raw)
          const icon = match ? match[1] : group.icon
          const label = match ? match[2] : raw
          if (icon === group.icon && label === group.name) return
          send({ type: 'groups:rename', id: group.id, name: label, icon })
        }
        name.addEventListener('blur', commitName)
        name.addEventListener('keydown', event => {
          if ((event as KeyboardEvent).key === 'Enter') name.blur()
        })

        /*
         * Members are reorderable, not just listed. `buildDisplayGroupRenderPlan`
         * lays the cards out inside the folded group in this order, and the
         * engine is explicit that it is meant to be the user's choice —
         * assigning modules one at a time only ever appends.
         */
        const members = ctx.dom.createElement('div', { class: 'dnd-app__group-members' })
        for (const [index, tag] of group.members.entries()) {
          const chip = ctx.dom.createElement('span', { class: 'dnd-app__member' })
          const tagName = ctx.dom.createElement('span')
          tagName.textContent = tag
          const up = ctx.dom.createElement('button', {
            type: 'button', title: `Move ${tag} earlier in the group`,
          }) as HTMLButtonElement
          up.textContent = '↑'
          up.disabled = index === 0
          up.addEventListener('click', () =>
            send({ type: 'groups:move', id: group.id, tag, direction: 'up' }))
          const down = ctx.dom.createElement('button', {
            type: 'button', title: `Move ${tag} later in the group`,
          }) as HTMLButtonElement
          down.textContent = '↓'
          down.disabled = index === group.members.length - 1
          down.addEventListener('click', () =>
            send({ type: 'groups:move', id: group.id, tag, direction: 'down' }))
          chip.append(tagName, up, down)
          members.appendChild(chip)
        }

        const remove = ctx.dom.createElement('button', {
          class: 'dnd-panel__button', type: 'button',
        }) as HTMLButtonElement
        remove.textContent = 'Ungroup'
        remove.title = 'Delete the group; its cards go back to rendering separately'
        remove.addEventListener('click', () => send({ type: 'groups:delete', id: group.id }))

        row.append(on, name, members, remove)
        groupList.appendChild(row)
      }

      // The "start a new group with" picker, then per-module assignment.
      newMember.textContent = ''
      for (const module of state.modules) {
        const option = ctx.dom.createElement('option') as HTMLOptionElement
        option.value = module.tag
        option.textContent = `${module.icon} ${module.label}`
        newMember.appendChild(option)
      }
      addGroup.disabled = !state.modules.length

      moduleList.textContent = ''
      for (const module of state.modules) {
        const row = ctx.dom.createElement('div', { class: 'dnd-app__mod' })
        const label = ctx.dom.createElement('span', { class: 'dnd-app__mod-name' })
        label.textContent = `${module.icon} ${module.label}`
        const kind = ctx.dom.createElement('span', { class: 'dnd-app__mod-kind' })
        kind.textContent = module.kind

        const pick = ctx.dom.createElement('select', { class: 'dnd-app__select' }) as HTMLSelectElement
        const none = ctx.dom.createElement('option') as HTMLOptionElement
        none.value = ''
        none.textContent = 'On its own'
        pick.appendChild(none)
        for (const group of state.groups) {
          const option = ctx.dom.createElement('option') as HTMLOptionElement
          option.value = group.id
          option.textContent = `${group.icon} ${group.name}`
          pick.appendChild(option)
        }
        pick.value = module.groupId ?? ''
        pick.addEventListener('change', () => send({
          type: 'groups:assign',
          tag: module.tag,
          groupId: pick.value || null,
        }))

        row.append(label, kind, pick)
        moduleList.appendChild(row)
      }
    },
    dispose() {
      removeThemeStyle?.()
    },
  }
}
