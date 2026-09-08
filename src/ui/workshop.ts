/**
 * workshop.ts — the maps, the agent's activity, and the terminal.
 *
 * One drawer tab holding the three things that answer "what is this thing
 * doing?": the maps it has drawn, the entries it is feeding the narrator right
 * now, and a way to tell any subsystem to do something specific.
 *
 * They share a tab because they are read together. Looking at a map usually
 * ends in telling the Map Updater it is wrong, and looking at the active keys
 * usually ends in telling the agent to go again.
 */

import type { SpindleDrawerTabHandle, SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type MapList = Extract<ToFrontend, { type: 'maps:list' }>
type MapRender = Extract<ToFrontend, { type: 'maps:render' }>
type MapDraft = Extract<ToFrontend, { type: 'maps:draft' }>
type MapSaved = Extract<ToFrontend, { type: 'maps:saved' }>
type MapExport = Extract<ToFrontend, { type: 'maps:export' }>
type AgentView = Extract<ToFrontend, { type: 'agent:view' }>
type TerminalResult = Extract<ToFrontend, { type: 'terminal:result' }>

export const WORKSHOP_CSS = `
.dnd-ws { display: flex; flex-direction: column; gap: 14px; padding: 8px; }
.dnd-ws__title { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dnd-ws__title small { font-weight: 400; opacity: .7; margin-left: auto; }
.dnd-ws__row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dnd-ws__select, .dnd-ws__input {
  padding: 7px 9px; border-radius: 6px; min-height: 34px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-ws__input { flex: 1 1 auto; min-width: 0; }
.dnd-ws__num { width: 74px; }
.dnd-ws__map { overflow-x: auto; }
.dnd-ws__map svg { max-width: 100%; height: auto; }
.dnd-ws__detail {
  margin-top: 8px; padding: 8px; border-radius: 6px; line-height: 1.5;
  background: rgba(128,128,128,.08); max-height: 300px; overflow-y: auto;
}
.dnd-ws__keys { display: flex; flex-wrap: wrap; gap: 6px; }
.dnd-ws__key {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 6px 3px 10px; border-radius: 999px; font-size: .9em;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.4));
}
.dnd-ws__key button {
  border: none; background: transparent; cursor: pointer; font: inherit;
  color: inherit; opacity: .7; padding: 0 3px;
}
.dnd-ws__key button:hover { opacity: 1; }
.dnd-ws__log { display: flex; flex-direction: column; gap: 3px; }
.dnd-ws__entry {
  display: flex; gap: 8px; padding: 5px 4px; line-height: 1.4;
  border-top: 1px solid var(--lumiverse-border, rgba(128,128,128,.18));
}
.dnd-ws__time { opacity: .7; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.dnd-ws__what { flex: 1 1 auto; }
.dnd-ws__delta { opacity: .8; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.dnd-ws__out {
  padding: 8px 10px; border-radius: 6px; line-height: 1.45; white-space: pre-wrap;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
}
.dnd-ws__out--bad { border-color: rgba(216,160,72,.55); }
.dnd-ws__empty { opacity: .75; line-height: 1.5; }
.dnd-ws__editor { display: flex; flex-direction: column; gap: 8px; }
.dnd-ws__json {
  width: 100%; min-height: 260px; padding: 8px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.5;
  white-space: pre; overflow-wrap: normal; overflow-x: auto;
}
.dnd-ws__errors {
  padding: 8px 10px; border-radius: 6px; line-height: 1.5;
  border: 1px solid rgba(216,120,72,.6);
}
.dnd-ws__errors ul { margin: 6px 0 0; padding-left: 18px; }
.dnd-ws__errors li { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
`

const TAB_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">'
  + '<path d="M3 6h5v5H3zM12 6h5v5h-5zM7.5 15h5"/><path d="M10 11v4"/></svg>'

const TARGETS: Array<{ value: string; label: string }> = [
  { value: 'tracker', label: 'State Tracker' },
  { value: 'agent', label: 'Lorebook Agent' },
  { value: 'map_updater', label: 'Map Updater' },
  { value: 'map_evolution', label: 'Map Evolution' },
  { value: 'map_architect', label: 'Map Architect' },
]

export interface WorkshopHandle {
  applyScene(message: Extract<ToFrontend, { type: 'scene:view' }>): void
  applyMaps(message: MapList): void
  applyMap(message: MapRender): void
  applyMapDraft(message: MapDraft): void
  applyMapSaved(message: MapSaved): void
  applyMapExport(message: MapExport): void
  applyAgent(message: AgentView): void
  applyTerminal(message: TerminalResult): void
  dispose(): void
}

export function installWorkshop(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): WorkshopHandle {
  let tab: SpindleDrawerTabHandle
  try {
    tab = ctx.ui.registerDrawerTab({
      id: 'workshop',
      title: 'Scene, Maps & Agent',
      shortName: 'Scene',
      description: 'The scene, site maps, what the agent is doing, and direct instructions',
      keywords: ['map', 'agent', 'terminal', 'lore', 'dnd'],
      headerTitle: 'Workshop',
      iconSvg: TAB_ICON,
    })
  } catch (error) {
    console.warn('[DnD] could not register the workshop tab:', error)
    return {
      applyScene() {}, applyMaps() {}, applyMap() {},
      applyMapDraft() {}, applyMapSaved() {}, applyMapExport() {},
      applyAgent() {}, applyTerminal() {}, dispose() {},
    }
  }

  const root = ctx.dom.createElement('div', { class: 'dnd-ws' })
  tab.root.appendChild(root)

  // ── the scene ───────────────────────────────────────────────────────────
  // First, because it is where the party actually is. Everything below it is
  // about inspecting the machinery.
  const sceneTitle = ctx.dom.createElement('div', { class: 'dnd-ws__title' })
  const sceneName = ctx.dom.createElement('span')
  sceneName.textContent = 'Where you are'
  const sceneWhere = ctx.dom.createElement('small')
  sceneTitle.append(sceneName, sceneWhere)

  const sceneBody = ctx.dom.createElement('div', { class: 'dnd-ws__map' })
  const sceneRow = ctx.dom.createElement('div', { class: 'dnd-ws__row' })
  const drawScene = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  drawScene.addEventListener('click', () => send({ type: 'scene:draw' }))
  const clearScene = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  clearScene.textContent = 'Remove art'
  clearScene.addEventListener('click', () => send({ type: 'scene:clear' }))
  sceneRow.append(drawScene, clearScene)

  // ── maps ────────────────────────────────────────────────────────────────
  const mapTitle = ctx.dom.createElement('div', { class: 'dnd-ws__title' })
  mapTitle.textContent = 'Site maps'
  const mapRow = ctx.dom.createElement('div', { class: 'dnd-ws__row' })
  const mapPick = ctx.dom.createElement('select', { class: 'dnd-ws__select' }) as HTMLSelectElement
  const revealLabel = ctx.dom.createElement('label', { class: 'dnd-ws__row' })
  const reveal = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
  const revealText = ctx.dom.createElement('span')
  // Off by default: the map is the GM's, and showing the unexplored half of a
  // dungeon in a panel the player is looking at spoils the thing they asked for.
  revealText.textContent = 'Reveal undiscovered areas'
  revealLabel.append(reveal, revealText)
  const drawMap = (): void => {
    if (!mapPick.value) return
    send({ type: 'maps:render', id: mapPick.value, revealAll: reveal.checked })
  }
  mapPick.addEventListener('change', () => {
    drawMap()
    // The editor is showing the previous map; reload it rather than letting a
    // save write one site's layout over another's.
    if (!editor.hidden && mapPick.value) send({ type: 'maps:edit', id: mapPick.value })
  })
  reveal.addEventListener('change', drawMap)
  // Correcting a map is a different mode from reading one, so it is a toggle
  // rather than a textarea sitting under every map you glance at.
  const editToggle = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  editToggle.textContent = 'Edit'
  editToggle.title = 'Correct this map by hand'
  mapRow.append(mapPick, revealLabel, editToggle)
  const mapBody = ctx.dom.createElement('div', { class: 'dnd-ws__map' })
  const mapDetail = ctx.dom.createElement('div', { class: 'dnd-ws__detail' })
  mapDetail.hidden = true

  // ── the map editor ──────────────────────────────────────────────────────
  const editor = ctx.dom.createElement('div', { class: 'dnd-ws__editor' })
  editor.hidden = true
  const mapJson = ctx.dom.createElement('textarea', {
    class: 'dnd-ws__json',
    spellcheck: 'false',
  }) as HTMLTextAreaElement
  const mapErrors = ctx.dom.createElement('div', { class: 'dnd-ws__errors' })
  mapErrors.hidden = true

  const editRow = ctx.dom.createElement('div', { class: 'dnd-ws__row' })
  const saveMap = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  saveMap.textContent = 'Save map'
  saveMap.addEventListener('click', () => {
    if (!mapPick.value) return
    saveMap.disabled = true
    send({ type: 'maps:save', id: mapPick.value, text: mapJson.value })
  })
  // Restore points, newest first. Loading one writes it, so it is a select
  // plus a button rather than a select that acts on change.
  const restorePick = ctx.dom.createElement('select', {
    class: 'dnd-ws__select',
    title: 'Earlier versions of this map',
  }) as HTMLSelectElement
  const restoreGo = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  restoreGo.textContent = 'Restore'
  restoreGo.addEventListener('click', () => {
    if (!mapPick.value || restorePick.value === '') return
    send({ type: 'maps:restore', id: mapPick.value, index: Number(restorePick.value) })
  })
  const exportMap = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  exportMap.textContent = 'Export'
  exportMap.title = 'Copy this map out as a portable package'
  exportMap.addEventListener('click', () => {
    if (mapPick.value) send({ type: 'maps:export', id: mapPick.value })
  })
  const importMap = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  importMap.textContent = 'Import'
  importMap.title = 'Replace this map’s layout from a package in the box above'
  importMap.addEventListener('click', () => {
    if (!mapPick.value) return
    send({ type: 'maps:import', id: mapPick.value, json: mapJson.value })
  })
  editRow.append(saveMap, restorePick, restoreGo, exportMap, importMap)

  const editNote = ctx.dom.createElement('div', { class: 'dnd-ws__empty' })
  editNote.textContent = 'Edits are checked against the map rules before they are '
    + 'stored — dangling exits, duplicate ids and impossible containers are refused, '
    + 'and the version you opened is kept as a restore point.'

  editor.append(mapJson, mapErrors, editRow, editNote)

  editToggle.addEventListener('click', () => {
    editor.hidden = !editor.hidden
    editToggle.textContent = editor.hidden ? 'Edit' : 'Close editor'
    if (!editor.hidden && mapPick.value) send({ type: 'maps:edit', id: mapPick.value })
  })

  // ── agent activity ──────────────────────────────────────────────────────
  const agentTitle = ctx.dom.createElement('div', { class: 'dnd-ws__title' })
  const agentName = ctx.dom.createElement('span')
  agentName.textContent = 'In the prompt now'
  const agentCount = ctx.dom.createElement('small')
  agentTitle.append(agentName, agentCount)
  const keys = ctx.dom.createElement('div', { class: 'dnd-ws__keys' })

  const logTitle = ctx.dom.createElement('div', { class: 'dnd-ws__title' })
  logTitle.textContent = 'Recent agent passes'
  const log = ctx.dom.createElement('div', { class: 'dnd-ws__log' })

  // ── terminal ────────────────────────────────────────────────────────────
  const termTitle = ctx.dom.createElement('div', { class: 'dnd-ws__title' })
  termTitle.textContent = 'Tell a subsystem what to do'
  const termRow = ctx.dom.createElement('div', { class: 'dnd-ws__row' })
  const target = ctx.dom.createElement('select', { class: 'dnd-ws__select' }) as HTMLSelectElement
  for (const entry of TARGETS) {
    const option = ctx.dom.createElement('option') as HTMLOptionElement
    option.value = entry.value
    option.textContent = entry.label
    target.appendChild(option)
  }
  const lookback = ctx.dom.createElement('input', {
    class: 'dnd-ws__input dnd-ws__num', type: 'number', min: '0', max: '100',
    title: 'Messages to read. Blank uses that subsystem\'s own setting.',
  }) as HTMLInputElement
  termRow.append(target, lookback)

  const instructionRow = ctx.dom.createElement('div', { class: 'dnd-ws__row' })
  const instruction = ctx.dom.createElement('input', {
    class: 'dnd-ws__input', type: 'text',
    placeholder: 'e.g. the inn burned down — update the map',
  }) as HTMLInputElement
  const run = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  run.textContent = 'Send'
  const fire = (): void => {
    if (!instruction.value.trim()) return
    run.disabled = true
    output.hidden = false
    output.classList.remove('dnd-ws__out--bad')
    output.textContent = 'Running…'
    send({
      type: 'terminal:run',
      target: target.value,
      instruction: instruction.value.trim(),
      lookback: lookback.value === '' ? null : Number(lookback.value),
    })
    instruction.value = ''
  }
  run.addEventListener('click', fire)
  instruction.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Enter') fire()
  })
  instructionRow.append(instruction, run)
  const output = ctx.dom.createElement('div', { class: 'dnd-ws__out' })
  output.hidden = true

  root.append(
    sceneTitle, sceneBody, sceneRow,
    mapTitle, mapRow, mapBody, mapDetail, editor,
    agentTitle, keys,
    logTitle, log,
    termTitle, termRow, instructionRow, output,
  )

  const refresh = (): void => {
    send({ type: 'scene:read' })
    send({ type: 'maps:list' })
    send({ type: 'agent:read' })
  }
  tab.onActivate(refresh)

  let injectedMap: Element | null = null
  let injectedDetail: Element | null = null

  /** Show why a map was refused, field by field where the validator said so. */
  const showErrors = (summary: string, errors: string[]): void => {
    mapErrors.textContent = ''
    mapErrors.hidden = false
    const head = ctx.dom.createElement('div')
    head.textContent = summary
    mapErrors.appendChild(head)
    if (!errors.length) return
    const list = ctx.dom.createElement('ul')
    for (const problem of errors) {
      const item = ctx.dom.createElement('li')
      item.textContent = problem
      list.appendChild(item)
    }
    mapErrors.appendChild(list)
  }

  const fillRestorePoints = (history: Array<{ at: number; note: string }>): void => {
    restorePick.textContent = ''
    if (!history.length) {
      const none = ctx.dom.createElement('option') as HTMLOptionElement
      none.value = ''
      none.textContent = 'No earlier versions'
      restorePick.appendChild(none)
      restorePick.disabled = true
      restoreGo.disabled = true
      return
    }
    restorePick.disabled = false
    restoreGo.disabled = false
    for (const [index, point] of history.entries()) {
      const option = ctx.dom.createElement('option') as HTMLOptionElement
      option.value = String(index)
      option.textContent = `${new Date(point.at).toLocaleString()} — ${point.note}`
      restorePick.appendChild(option)
    }
  }

  let injectedScene: Element | null = null

  return {
    applyScene(message) {
      if (injectedScene) { ctx.dom.uninject(injectedScene); injectedScene = null }
      sceneBody.textContent = ''
      sceneWhere.textContent = message.where ?? ''

      if (!message.ok) {
        const note = ctx.dom.createElement('div', { class: 'dnd-ws__empty' })
        note.textContent = message.reason === 'no campaign state yet'
          ? 'Play a turn and the scene will fill in.'
          : `Scene unavailable — ${message.reason ?? 'unknown reason'}.`
        sceneBody.appendChild(note)
      } else if (message.html) {
        injectedScene = ctx.dom.inject(sceneBody, message.html, 'beforeend')
      }

      // Drawing costs money on a paid endpoint, so the button says which it is.
      drawScene.textContent = message.hasArt ? 'Redraw scene' : 'Draw this scene'
      drawScene.disabled = !message.canDraw || !message.ok
      drawScene.title = message.canDraw
        ? 'Generate an image of this location'
        : 'Set up an image generation connection in Lumiverse first'
      clearScene.hidden = !message.hasArt
    },
    applyMaps(message) {
      const previous = mapPick.value
      mapPick.textContent = ''
      if (!message.ok || !message.maps.length) {
        const none = ctx.dom.createElement('option') as HTMLOptionElement
        none.textContent = message.ok
          ? 'No maps yet — the narrator draws one when the story enters somewhere worth mapping'
          : `Maps unavailable — ${message.reason ?? 'unknown reason'}`
        mapPick.appendChild(none)
        mapPick.disabled = true
        return
      }
      mapPick.disabled = false
      for (const map of message.maps) {
        const option = ctx.dom.createElement('option') as HTMLOptionElement
        option.value = map.id
        option.textContent = `${map.site} — ${map.visited}/${map.areas} explored`
        mapPick.appendChild(option)
      }
      mapPick.value = message.maps.some(m => m.id === previous) ? previous : message.maps[0].id
      drawMap()
    },
    applyMap(message) {
      if (injectedMap) { ctx.dom.uninject(injectedMap); injectedMap = null }
      if (injectedDetail) { ctx.dom.uninject(injectedDetail); injectedDetail = null }
      mapBody.textContent = ''
      mapDetail.textContent = ''

      if (!message.ok) {
        const note = ctx.dom.createElement('div', { class: 'dnd-ws__empty' })
        note.textContent = `Could not draw that map — ${message.reason ?? 'unknown reason'}.`
        mapBody.appendChild(note)
        mapDetail.hidden = true
        return
      }
      // The engine returns markup; the host sanitises it on injection, the same
      // path the tracker cards take.
      if (message.svg) injectedMap = ctx.dom.inject(mapBody, message.svg, 'beforeend')
      if (message.detail) {
        mapDetail.hidden = false
        injectedDetail = ctx.dom.inject(mapDetail, message.detail, 'beforeend')
      } else {
        mapDetail.hidden = true
      }
    },
    applyMapDraft(message) {
      if (message.id !== mapPick.value) return
      saveMap.disabled = false
      if (!message.ok) {
        showErrors(`Could not open that map — ${message.reason ?? 'unknown reason'}.`, [])
        mapJson.value = ''
        return
      }
      mapErrors.hidden = true
      mapJson.value = message.text ?? ''
      fillRestorePoints(message.history ?? [])
    },
    applyMapSaved(message) {
      if (message.id !== mapPick.value) return
      saveMap.disabled = false
      if (!message.ok) {
        showErrors(message.reason ?? 'The map was not saved.', message.errors ?? [])
        return
      }
      mapErrors.hidden = true
      fillRestorePoints(message.history ?? [])
      // The stored map changed, so the picture above it is now stale.
      drawMap()
    },
    applyMapExport(message) {
      if (!message.ok) {
        showErrors(`Could not export — ${message.reason ?? 'unknown reason'}.`, [])
        return
      }
      // The box is the exchange point in both directions: what lands here is
      // what Import reads, so exporting and importing need no file dialog.
      editor.hidden = false
      editToggle.textContent = 'Close editor'
      mapJson.value = message.json ?? ''
      mapErrors.hidden = true
    },
    applyAgent(message) {
      agentCount.textContent = message.ok
        ? `${message.keys.length}${message.maxActive ? ` / ${message.maxActive}` : ''}`
          + (message.running ? ' · running' : '')
        : ''

      keys.textContent = ''
      if (!message.keys.length) {
        const none = ctx.dom.createElement('div', { class: 'dnd-ws__empty' })
        none.textContent = message.ok
          ? 'Nothing being injected right now.'
          : `Unavailable — ${message.reason ?? 'unknown reason'}.`
        keys.appendChild(none)
      }
      for (const key of message.keys) {
        const chip = ctx.dom.createElement('span', { class: 'dnd-ws__key' })
        const label = ctx.dom.createElement('span')
        label.textContent = key.label + (key.pinned ? ' 📌' : '')
        const drop = ctx.dom.createElement('button', {
          type: 'button', title: 'Take this out of the prompt',
        }) as HTMLButtonElement
        drop.textContent = '×'
        drop.addEventListener('click', () => send({ type: 'agent:deactivate', id: key.id }))
        chip.append(label, drop)
        keys.appendChild(chip)
      }

      log.textContent = ''
      if (!message.log.length) {
        const none = ctx.dom.createElement('div', { class: 'dnd-ws__empty' })
        none.textContent = 'No passes recorded yet.'
        log.appendChild(none)
      }
      for (const entry of message.log) {
        const row = ctx.dom.createElement('div', { class: 'dnd-ws__entry' })
        const time = ctx.dom.createElement('span', { class: 'dnd-ws__time' })
        time.textContent = entry.time
        const what = ctx.dom.createElement('span', { class: 'dnd-ws__what' })
        what.textContent = entry.reason || 'Agent pass'
        const delta = ctx.dom.createElement('span', { class: 'dnd-ws__delta' })
        // Only the non-zero parts: a row of zeroes says nothing.
        delta.textContent = [
          entry.recorded ? `+${entry.recorded}` : '',
          entry.rewritten ? `~${entry.rewritten}` : '',
          entry.deleted ? `−${entry.deleted}` : '',
        ].filter(Boolean).join(' ')
        row.append(time, what, delta)
        log.appendChild(row)
      }
    },
    applyTerminal(message) {
      run.disabled = false
      output.hidden = false
      output.textContent = message.output
      output.classList.toggle('dnd-ws__out--bad', !message.ok)
      // A pass can have changed maps or the active set.
      refresh()
    },
    dispose() {
      if (injectedScene) ctx.dom.uninject(injectedScene)
      if (injectedMap) ctx.dom.uninject(injectedMap)
      if (injectedDetail) ctx.dom.uninject(injectedDetail)
      tab.destroy()
    },
  }
}
