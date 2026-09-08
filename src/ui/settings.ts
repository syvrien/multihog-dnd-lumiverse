/**
 * settings.ts — the settings surface.
 *
 * Rendered from `shared/settings-schema.ts`, so a new setting is one schema
 * entry rather than markup here plus a handler on the backend.
 *
 * Placement: Lumiverse exposes `ctx.ui.registerSettingsTab()`, which is where
 * users look for extension settings — but it is **not in the published
 * `lumiverse-spindle-types`**, only in the host's internal context type. Given
 * how often the types have trailed the runtime in this port, it is called
 * behind a capability check with a drawer tab as the fallback, so the settings
 * are reachable either way.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import {
  SETTINGS_SCHEMA,
  type SettingField,
  valueFor,
} from '../shared/settings-schema'
import { sourceKeyForProfileKey } from '../shared/settings-schema'
import { CONTROL_ROOM_CSS, buildControlRoom } from './control-room'
import { MODULES_CSS, buildModulesEditor } from './modules'
import { CARTRIDGE_CSS, buildCartridges } from './cartridges'
import { APPEARANCE_CSS, buildAppearance } from './appearance'
import { BLOCKS_CSS, buildBlocks } from './blocks'
import { CORTEX_CSS, buildCortex } from './cortex'
import type { ToBackend, ToFrontend } from '../shared/protocol'

/** The settings-tab API, absent from the published types. */
interface SettingsTabCapableUI {
  registerSettingsTab?: (options: {
    id: string
    title?: string
    shortName?: string
    description?: string
    keywords?: string[]
    iconSvg?: string
  }) => { root: HTMLElement; destroy(): void }
}

const SETTINGS_CSS = `
.dnd-settings__search { display: flex; gap: 8px; align-items: center; padding: 8px 8px 0; }
.dnd-settings__search-input {
  flex: 1 1 auto; min-width: 0; min-height: 34px; padding: 7px 10px; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-settings__search-count {
  flex: 0 0 auto; opacity: .7; font-size: .9em; white-space: nowrap;
}
.dnd-settings [hidden] { display: none !important; }

.dnd-settings { display: flex; flex-direction: column; gap: 20px; padding: 4px 2px 16px; }
.dnd-settings__section { display: flex; flex-direction: column; gap: 10px; }
.dnd-settings__heading { font-weight: 600; }
.dnd-settings__note {
  color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); line-height: 1.45;
}
.dnd-settings__field {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 8px 0; border-top: 1px solid var(--lumiverse-border, rgba(128,128,128,.22));
}
.dnd-settings__label { flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px; }
.dnd-settings__help {
  color: var(--lumiverse-text-dim, rgba(160,160,160,.95));
  font-size: .92em; line-height: 1.4;
}
.dnd-settings__control { flex: 0 0 auto; display: flex; align-items: center; }
.dnd-settings__control input[type="checkbox"] { width: 20px; height: 20px; cursor: pointer; }
.dnd-settings__control input[type="number"],
.dnd-settings__control select,
.dnd-settings__text {
  padding: 7px 9px; border-radius: 6px; min-height: 34px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-settings__control input[type="number"] { width: 108px; }
.dnd-settings__control select { max-width: 260px; }
.dnd-settings__field--wide { flex-direction: column; align-items: stretch; gap: 6px; }
.dnd-settings__text { width: 100%; }
.dnd-settings__group {
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.22));
  border-radius: 8px; padding: 0 10px;
}
.dnd-settings__group[open] { padding-bottom: 8px; }
.dnd-settings__summary {
  cursor: pointer; padding: 10px 2px; font-weight: 600; list-style: none;
}
.dnd-settings__summary::-webkit-details-marker { display: none; }
/* A disclosure triangle the host's theme cannot strip. */
.dnd-settings__summary::before { content: '▸ '; opacity: .7; }
.dnd-settings__group[open] .dnd-settings__summary::before { content: '▾ '; }
/* The first field under a summary would otherwise draw a rule against it. */
.dnd-settings__group .dnd-settings__field:first-of-type { border-top: none; }
.dnd-settings__saved {
  align-self: flex-start; padding: 6px 10px; border-radius: 6px;
  border: 1px solid rgba(120,200,140,.5);
  color: var(--lumiverse-text-dim, rgba(160,160,160,.95));
}
`

export interface SettingsHandle {
  /** Apply values pushed from the backend. */
  apply(values: Record<string, unknown>, connections: Array<{ id: string; name: string }>): void
  /** Apply the narrator ruleset's sections, which are not schema-driven. */
  applySections(state: Extract<ToFrontend, { type: 'sysprompt:sections' }>): void
  /** Apply the agent's record types, which are runtime data too. */
  applyModules(state: Extract<ToFrontend, { type: 'modules:state' }>): void
  /** Saved configurations, and the contents of one being opened. */
  applyCartridges(state: Extract<ToFrontend, { type: 'cartridge:state' }>): void
  applyCartridgeDetail(detail: Extract<ToFrontend, { type: 'cartridge:detail' }>): void
  applyCartridgeExport(message: Extract<ToFrontend, { type: 'cartridge:exported' }>): void
  /** Panel palette and drawn portraits. */
  applyTheme(state: Extract<ToFrontend, { type: 'theme:state' }>): void
  applyThemeDraft(draft: Extract<ToFrontend, { type: 'theme:draft' }>): void
  applyPortraitGen(state: Extract<ToFrontend, { type: 'portrait:gen-state' }>): void
  applyPortraitResult(result: Extract<ToFrontend, { type: 'portrait:gen-result' }>): void
  applyGroups(state: Extract<ToFrontend, { type: 'groups:state' }>): void
  applyBlocks(state: Extract<ToFrontend, { type: 'blocks:state' }>): void
  /** Card schemas. Distinct from `applySections`, which is the narrator ruleset. */
  applyCardSections(state: Extract<ToFrontend, { type: 'sections:state' }>): void
  applyCortex(state: Extract<ToFrontend, { type: 'cortex:state' }>): void
  applyCortexSynced(message: Extract<ToFrontend, { type: 'cortex:synced' }>): void
  dispose(): void
}

export function installSettings(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
  icon: string,
): SettingsHandle {
  const removeStyle = ctx.dom.addStyle(
    SETTINGS_CSS + CONTROL_ROOM_CSS + MODULES_CSS + CARTRIDGE_CSS + APPEARANCE_CSS
    + BLOCKS_CSS + CORTEX_CSS,
  )
  const controlRoom = buildControlRoom(ctx, send)
  const modulesEditor = buildModulesEditor(ctx, send)
  const cartridges = buildCartridges(ctx, send)
  const appearance = buildAppearance(ctx, send)
  const blocks = buildBlocks(ctx, send)
  const cortex = buildCortex(ctx, send)

  const ui = ctx.ui as unknown as SettingsTabCapableUI
  let destroyHost: () => void = () => {}
  let root: HTMLElement

  if (typeof ui.registerSettingsTab === 'function') {
    const tab = ui.registerSettingsTab({
      id: 'multihog_dnd',
      title: 'Multihog D&D',
      shortName: 'D&D',
      description: 'RPG framework: state tracker, systems, and display options',
      keywords: ['rpg', 'dnd', 'tracker', 'campaign'],
      iconSvg: icon,
    })
    root = tab.root
    destroyHost = () => tab.destroy()
  } else {
    // Older or newer host without the settings tab: fall back to a drawer tab
    // so the settings are still reachable.
    const tab = ctx.ui.registerDrawerTab({
      id: 'dnd-settings',
      title: 'D&D Settings',
      shortName: 'D&D Cfg',
      description: 'Settings for the Multihog D&D framework',
      keywords: ['rpg', 'dnd', 'settings'],
      iconSvg: icon,
    })
    root = tab.root
    destroyHost = () => tab.destroy()
  }

  /*
   * Search across every setting.
   *
   * Eight sections and their collapsed groups is more than anyone holds in
   * their head, and upstream ships a keyword filter for exactly that reason.
   * Its version (`settings-search.js`, 419 lines) walks SillyTavern's drawer
   * markup looking for `label`, `.checkbox_label`, `small` and the rest,
   * because it did not build that markup. This one did, so the index is built
   * as the fields are rendered and the filter is the honest three lines it
   * should be.
   */
  const searchWrap = ctx.dom.createElement('div', { class: 'dnd-settings__search' })
  const search = ctx.dom.createElement('input', {
    class: 'dnd-settings__search-input',
    type: 'search',
    placeholder: 'Search settings…',
    'aria-label': 'Search settings',
  }) as HTMLInputElement
  const searchCount = ctx.dom.createElement('span', { class: 'dnd-settings__search-count' })
  searchWrap.append(search, searchCount)
  root.appendChild(searchWrap)

  const container = ctx.dom.createElement('div', { class: 'dnd-settings' })
  root.appendChild(container)

  interface SearchEntry {
    /** The thing shown or hidden. */
    element: HTMLElement
    /** Lower-cased haystack: label, help text and the settings key. */
    text: string
    /** The collapsible group holding it, if any. */
    group: HTMLDetailsElement | null
    /** The section block holding it. */
    section: HTMLElement | null
  }
  let searchIndex: SearchEntry[] = []

  /**
   * Filter to matching rows.
   *
   * A group holding a hit is forced open — a match hidden inside a closed
   * `<details>` is the same as no match at all. The open state is restored when
   * the query is cleared, so searching does not permanently unfold the page.
   */
  const applySearch = (): void => {
    const query = search.value.trim().toLowerCase()
    const groupWasOpen = new Map<HTMLDetailsElement, boolean>()

    if (!query) {
      for (const entry of searchIndex) {
        entry.element.hidden = false
        if (entry.section) entry.section.hidden = false
        if (entry.group) entry.group.hidden = false
      }
      // Restore what the schema asked for, not what the last search left.
      for (const group of new Set(searchIndex.map(e => e.group).filter(Boolean))) {
        const details = group as HTMLDetailsElement
        if (details.dataset.dndOpenByDefault === 'true') details.setAttribute('open', '')
        else details.removeAttribute('open')
      }
      searchCount.textContent = ''
      return
    }

    let hits = 0
    const liveGroups = new Set<HTMLDetailsElement>()
    const liveSections = new Set<HTMLElement>()

    for (const entry of searchIndex) {
      const hit = entry.text.includes(query)
      entry.element.hidden = !hit
      if (!hit) continue
      hits++
      if (entry.group) liveGroups.add(entry.group)
      if (entry.section) liveSections.add(entry.section)
    }

    for (const group of new Set(searchIndex.map(e => e.group).filter(Boolean))) {
      const details = group as HTMLDetailsElement
      const live = liveGroups.has(details)
      details.hidden = !live
      if (live) details.setAttribute('open', '')
      groupWasOpen.set(details, live)
    }
    for (const section of new Set(searchIndex.map(e => e.section).filter(Boolean))) {
      const block = section as HTMLElement
      block.hidden = !liveSections.has(block)
    }

    searchCount.textContent = hits ? `${hits} setting${hits === 1 ? '' : 's'}` : 'nothing found'
  }
  search.addEventListener('input', applySearch)

  /** Controls by setting key, so backend pushes can refresh them in place. */
  const controls = new Map<string, (value: unknown) => void>()
  /** The field each control came from, so refreshes keep the right fallback. */
  const fields = new Map<string, SettingField>()
  let connectionOptions: Array<{ id: string; name: string }> = []
  const connectionSelects: HTMLSelectElement[] = []

  const patch = (key: string, value: unknown): void => {
    send({ type: 'settings:patch', patch: { [key]: value } })
  }

  /**
   * What a field is searchable by.
   *
   * The settings key is in there deliberately: someone reading a log line about
   * `routerCampaignPrefix` should be able to paste it in and land on the field,
   * even though nothing on screen says that word.
   */
  const indexText = (field: SettingField, context: string): string =>
    [context, field.label, field.help ?? '', field.key].join(' ').toLowerCase()

  const buildField = (field: SettingField, values: Record<string, unknown>): HTMLElement => {
    const wide = field.kind === 'text' || field.kind === 'textarea'
    const row = ctx.dom.createElement('div', {
      class: `dnd-settings__field${wide ? ' dnd-settings__field--wide' : ''}`,
    })

    const label = ctx.dom.createElement('label', { class: 'dnd-settings__label' })
    const title = ctx.dom.createElement('span')
    title.textContent = field.label
    label.appendChild(title)
    if (field.help) {
      const help = ctx.dom.createElement('span', { class: 'dnd-settings__help' })
      help.textContent = field.help
      label.appendChild(help)
    }

    const control = ctx.dom.createElement('div', { class: 'dnd-settings__control' })
    const current = valueFor(values, field)
    fields.set(field.key, field)

    switch (field.kind) {
      case 'toggle': {
        const input = ctx.dom.createElement('input') as HTMLInputElement
        input.type = 'checkbox'
        input.checked = !!current
        input.addEventListener('change', () => patch(field.key, input.checked))
        controls.set(field.key, value => { input.checked = !!value })
        control.appendChild(input)
        break
      }
      case 'number': {
        const input = ctx.dom.createElement('input') as HTMLInputElement
        input.type = 'number'
        if (field.min !== undefined) input.min = String(field.min)
        if (field.max !== undefined) input.max = String(field.max)
        if (field.step !== undefined) input.step = String(field.step)
        input.value = String(Number(current) || 0)
        input.addEventListener('change', () => patch(field.key, Number(input.value) || 0))
        controls.set(field.key, value => { input.value = String(Number(value) || 0) })
        control.appendChild(input)
        break
      }
      case 'text': {
        const input = ctx.dom.createElement('input', { class: 'dnd-settings__text' }) as HTMLInputElement
        input.type = 'text'
        input.value = String(current ?? '')
        input.addEventListener('change', () => patch(field.key, input.value))
        controls.set(field.key, value => { input.value = String(value ?? '') })
        row.appendChild(label)
        row.appendChild(input)
        return row
      }
      case 'textarea': {
        const input = ctx.dom.createElement('textarea', { class: 'dnd-settings__text' }) as HTMLTextAreaElement
        input.rows = field.rows ?? 4
        input.value = String(current ?? '')
        input.addEventListener('change', () => patch(field.key, input.value))
        controls.set(field.key, value => { input.value = String(value ?? '') })
        row.appendChild(label)
        row.appendChild(input)
        return row
      }
      case 'select': {
        const select = ctx.dom.createElement('select') as HTMLSelectElement
        for (const option of field.options) {
          const el = ctx.dom.createElement('option') as HTMLOptionElement
          el.value = option.value
          el.textContent = option.label
          select.appendChild(el)
        }
        select.value = String(current ?? field.fallback)
        select.addEventListener('change', () => patch(field.key, select.value))
        controls.set(field.key, value => { select.value = String(value ?? '') })
        control.appendChild(select)
        break
      }
      case 'connection': {
        const select = ctx.dom.createElement('select') as HTMLSelectElement
        // Remember the configured id now; the options themselves are filled in
        // once the connection list arrives, and `select.value` cannot hold an
        // id that has no matching <option> yet.
        select.dataset.selected = String(current ?? '')
        connectionSelects.push(select)
        select.addEventListener('change', () => {
          // The engine only consults a `…ConnectionProfileId` when its matching
          // `…ConnectionSource` says `profile`, so keep the two in step — and
          // it has to be *this* field's source key. Hard-coding the tracker's
          // `connectionSource` worked while there was only one connection
          // field; with a second, picking a Map Architect connection set the
          // tracker's source and left the map's alone, so the pick was ignored.
          send({
            type: 'settings:patch',
            patch: {
              [field.key]: select.value,
              [sourceKeyForProfileKey(field.key)]: 'profile',
            },
          })
        })
        controls.set(field.key, value => {
          select.dataset.selected = String(value ?? '')
          select.value = String(value ?? '')
        })
        control.appendChild(select)
        break
      }
    }

    row.appendChild(label)
    row.appendChild(control)
    return row
  }

  const render = (values: Record<string, unknown>): void => {
    container.textContent = ''
    controls.clear()
    fields.clear()
    connectionSelects.length = 0
    searchIndex = []

    for (const section of SETTINGS_SCHEMA) {
      const block = ctx.dom.createElement('div', { class: 'dnd-settings__section' })
      const heading = ctx.dom.createElement('div', { class: 'dnd-settings__heading' })
      heading.textContent = section.title
      block.appendChild(heading)

      if (section.description) {
        const note = ctx.dom.createElement('div', { class: 'dnd-settings__note' })
        note.textContent = section.description
        block.appendChild(note)
      }

      for (const field of section.fields) {
        const row = buildField(field, values)
        block.appendChild(row)
        searchIndex.push({
          element: row,
          text: indexText(field, section.title),
          group: null,
          section: block,
        })
      }

      // Collapsible groups, mirroring how upstream organises its settings
      // window: the things most people change stay in front of them, and the
      // rest is one click away rather than another screen of scrolling.
      for (const group of section.groups ?? []) {
        const details = ctx.dom.createElement('details', { class: 'dnd-settings__group' })
        if (group.open) details.setAttribute('open', '')
        const summary = ctx.dom.createElement('summary', { class: 'dnd-settings__summary' })
        summary.textContent = group.title
        details.appendChild(summary)
        if (group.description) {
          const note = ctx.dom.createElement('div', { class: 'dnd-settings__note' })
          note.textContent = group.description
          details.appendChild(note)
        }
        // Remembered so clearing the search restores the schema's own state
        // rather than leaving everything a search touched unfolded.
        details.dataset.dndOpenByDefault = String(!!group.open)
        for (const field of group.fields) {
          const row = buildField(field, values)
          details.appendChild(row)
          searchIndex.push({
            element: row,
            text: indexText(field, `${section.title} ${group.title}`),
            group: details,
            section: block,
          })
        }
        block.appendChild(details)
      }

      /*
       * The editors embedded in a section are not schema rows, so they cannot
       * be filtered field by field. They are indexed as one element each,
       * against the words someone would actually search for to find them —
       * otherwise searching "theme" or "portrait" hides the very panel that
       * does it.
       */
      /*
       * Beside the Lorebook Agent, because that is the thing it overlaps: both
       * are long-term memory of the same campaign, and the question the panel
       * answers is whether they are duplicating each other.
       */
      if (section.id === 'lorebook-agent') {
        block.appendChild(cortex.root)
        searchIndex.push({
          element: cortex.root,
          text: 'memory cortex lumiverse summarizer summary entities graph arcs '
            + 'consolidation retrieval long term memory summaryception context',
          group: null,
          section: block,
        })
        block.appendChild(modulesEditor.root)
        searchIndex.push({
          element: modulesEditor.root,
          text: 'record types modules npc location faction quest event lorebook agent '
            + 'instruction format repertoire',
          group: null,
          section: block,
        })
      }
      /*
       * The tracker's own cards belong with Game Systems — that section is
       * already "what is being tracked", and the order list is the same
       * question asked about presentation.
       */
      if (section.id === 'modules') {
        block.appendChild(blocks.root)
        searchIndex.push({
          element: blocks.root,
          text: 'modules cards blocks order reorder enable disable custom module '
            + 'tracked tag icon npc pc card sections schema species body personality',
          group: null,
          section: block,
        })
      }
      if (section.id === 'general') {
        block.appendChild(appearance.root)
        searchIndex.push({
          element: appearance.root,
          text: 'theme palette colour color appearance portrait image avatar '
            + 'display groups fold cards panel look',
          group: null,
          section: block,
        })
      }
      container.appendChild(block)
    }

    // The narrator ruleset is not schema-driven — its sections come from the
    // engine at runtime, and a Game System adds to them.
    const ruleBlock = ctx.dom.createElement('div', { class: 'dnd-settings__section' })
    const ruleHeading = ctx.dom.createElement('div', { class: 'dnd-settings__heading' })
    ruleHeading.textContent = 'Narrator ruleset'
    ruleBlock.append(ruleHeading, controlRoom.root)
    searchIndex.push({
      element: controlRoom.root,
      text: 'narrator ruleset sysprompt system prompt sections rules game systems '
        + 'order enable disable',
      group: null,
      section: ruleBlock,
    })
    container.appendChild(ruleBlock)

    // Last, because a cartridge is every setting above it in one bundle.
    const cartBlock = ctx.dom.createElement('div', { class: 'dnd-settings__section' })
    const cartHeading = ctx.dom.createElement('div', { class: 'dnd-settings__heading' })
    cartHeading.textContent = 'Saved setups'
    cartBlock.append(cartHeading, cartridges.root)
    searchIndex.push({
      element: cartridges.root,
      text: 'cartridge saved setup preset backup export import snapshot configuration',
      group: null,
      section: cartBlock,
    })
    container.appendChild(cartBlock)

    fillConnections()
    // A render can happen while a query is typed — a settings sync, a cartridge
    // load. Re-applying keeps the filter true rather than silently dropping it.
    applySearch()
  }

  const fillConnections = (): void => {
    for (const select of connectionSelects) {
      const selected = select.dataset.selected ?? select.value
      select.textContent = ''

      const none = ctx.dom.createElement('option') as HTMLOptionElement
      none.value = ''
      none.textContent = connectionOptions.length ? 'Select a connection…' : 'No connections available'
      select.appendChild(none)

      for (const connection of connectionOptions) {
        const option = ctx.dom.createElement('option') as HTMLOptionElement
        option.value = connection.id
        option.textContent = connection.name
        select.appendChild(option)
      }
      select.value = selected
    }
  }

  let rendered = false

  return {
    apply(values, connections) {
      connectionOptions = connections ?? []
      if (!rendered) {
        render(values)
        rendered = true
        return
      }
      // Refresh in place so a backend push does not blow away focus or scroll.
      for (const [key, set] of controls) {
        const field = fields.get(key)
        if (field) set(valueFor(values, field))
      }
      fillConnections()
    },
    applySections(state) {
      controlRoom.apply(state)
    },
    applyModules(state) {
      modulesEditor.apply(state)
    },
    applyCartridges(state) {
      cartridges.apply(state)
    },
    applyCartridgeDetail(detail) {
      cartridges.applyDetail(detail)
    },
    applyCartridgeExport(message) {
      cartridges.applyExport(message)
    },
    applyTheme(state) {
      appearance.applyTheme(state)
    },
    applyThemeDraft(draft) {
      appearance.applyDraft(draft)
    },
    applyPortraitGen(state) {
      appearance.applyGenState(state)
    },
    applyPortraitResult(result) {
      appearance.applyGenResult(result)
    },
    applyGroups(state) {
      appearance.applyGroups(state)
    },
    applyBlocks(state) {
      blocks.applyBlocks(state)
    },
    applyCardSections(state) {
      blocks.applySections(state)
    },
    applyCortex(state) {
      cortex.apply(state)
    },
    applyCortexSynced(message) {
      cortex.applySynced(message)
    },
    dispose() {
      appearance.dispose()
      destroyHost()
      removeStyle()
    },
  }
}
