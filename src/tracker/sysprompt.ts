/**
 * sysprompt.ts — the narrator's ruleset.
 *
 * `sysprompt.txt` is 377 lines and 54 sections: how to roll, how combat works,
 * quests, loot, XP, resting, the status footer, party benching, mapping. It is
 * what makes the narrator play the game the tracker is tracking.
 *
 * **It has never been delivered by this port.** Upstream assembles it in
 * `index.js`'s `buildSysprompt()` and writes the result into SillyTavern's Main
 * prompt textarea through the `autoApplySysprompt` runtime action — a preset
 * surface with no Lumiverse equivalent, so the port left that action throwing
 * and nothing took its place. The text was bundled in `constants.js` the whole
 * time and read by nothing but the cartridge differ.
 *
 * The visible consequence: the Narrator Configuration toggles in settings
 * (quests, loot, resting, party benching, persistent maps) looked live and, for
 * the narrator, mostly were not. They gate the tracker's own behaviour and, in
 * the maps case, tool registration — but the rules that teach the model to
 * *produce* quests or loot never reached it.
 *
 * There is no preset here, so delivery goes where every other injection in this
 * port goes: the interceptor, as a system message ahead of the conversation.
 *
 * `buildSysprompt()` itself is rebuilt rather than ported, because it lives in
 * the file the port replaces. It follows upstream line for line — same order
 * resolution, same transforms, same CYOA exclusion (CYOA is injected separately
 * by the interceptor, above the RNG queue).
 */

interface EngineBits {
  getSettings: () => Record<string, any>
  RT_PROMPTS: Record<string, string>
  extractTopLevelSections: (raw: string) => Array<{ tag: string; content: string }>
  normalizeSectionOrder: (
    settings: unknown,
    baseSections: Array<{ tag: string; content: string }>,
  ) => string[]
  getSectionRowDescriptor: (
    key: string,
    settings: unknown,
    baseSectionMap: Map<string, string>,
  ) => { enabled?: boolean; kind?: string; tag?: string; content?: string } | null
  transformBaseSectionContent: (tag: string, inner: string, settings: unknown) => string
  isBlankSectionContent: (content: string) => boolean
  buildModulesInstructionText: (settings: unknown) => string
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, constants, systems, memo] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/constants.js'),
    import('../engine/game-systems.js'),
    import('../engine/memo-processor.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    RT_PROMPTS: constants.RT_PROMPTS,
    extractTopLevelSections: systems.extractTopLevelSections,
    normalizeSectionOrder: systems.normalizeSectionOrder,
    getSectionRowDescriptor: systems.getSectionRowDescriptor,
    transformBaseSectionContent: systems.transformBaseSectionContent,
    isBlankSectionContent: systems.isBlankSectionContent,
    buildModulesInstructionText: memo.buildModulesInstructionText,
  }
  return cached
}

/** The shipped ruleset, before any of the user's edits or additions. */
export async function baseSyspromptText(): Promise<string> {
  const bits = await engine()
  return String(bits.RT_PROMPTS['sysprompt.txt'] ?? '')
}

/**
 * Assemble the narrator system prompt.
 *
 * Follows upstream's `buildSysprompt()`: walk the Control Room order, resolve
 * each key to a row, drop the disabled ones, and let built-in sections through
 * their transform (which is what makes "24-hour time" or "no RNG" actually
 * change the rules rather than just the display).
 */
export async function buildSysprompt(rawText?: string): Promise<string> {
  const bits = await engine()
  const raw = rawText ?? String(bits.RT_PROMPTS['sysprompt.txt'] ?? '')
  if (!raw) return ''

  const settings = bits.getSettings()
  const baseSections = bits.extractTopLevelSections(raw)
  const baseSectionMap = new Map(baseSections.map(section => [section.tag, section.content]))
  const order = bits.normalizeSectionOrder(settings, baseSections)

  const pieces = order.map(key => {
    const row = bits.getSectionRowDescriptor(key, settings, baseSectionMap)
    if (!row || !row.enabled) return ''
    // CYOA is injected above the RNG queue by the interceptor, never here.
    if (row.tag === 'CYOA_mode') return ''
    if (row.kind === 'base') {
      return bits.transformBaseSectionContent(row.tag ?? '', row.content ?? '', settings)
    }
    // Unlocked, custom and wizard rows already carry their own <tag>…</tag>.
    return bits.isBlankSectionContent(row.content ?? '') ? '' : row.content ?? ''
  }).filter(Boolean)

  let content = pieces.join('\n\n')
  content = content.replace('{{modulesText}}', bits.buildModulesInstructionText(settings))

  if (!settings.rngEnabled) {
    // With the dice tools off, instructions to call them are worse than absent.
    content = content
      .replace(/.*RollTheDice(?:D100)?.*\n?/gi, '')
      .replace(/.*\[RNG_QUEUE(?:_d100)?\s+v[\d.]+[^\]]*\].*\n?/gi, '')
  }

  return content.replace(/\n{3,}/g, '\n\n').trim()
}

export interface SectionRow {
  key: string
  tag: string
  label: string
  enabled: boolean
  /** `base` is shipped; `lib` is something the user or a Game System added. */
  kind: string
}

/** Every section in render order, for the Control Room. */
export async function listSections(): Promise<SectionRow[]> {
  const bits = await engine()
  const settings = bits.getSettings()
  const raw = String(bits.RT_PROMPTS['sysprompt.txt'] ?? '')
  const baseSections = bits.extractTopLevelSections(raw)
  const baseSectionMap = new Map(baseSections.map(section => [section.tag, section.content]))

  const rows: SectionRow[] = []
  for (const key of bits.normalizeSectionOrder(settings, baseSections)) {
    const row = bits.getSectionRowDescriptor(key, settings, baseSectionMap)
    if (!row) continue
    const tag = String(row.tag ?? key)
    rows.push({
      key,
      tag,
      // The tags are the extension's own vocabulary; a readable label beats
      // making the user parse `dungeon_reality_and_hidden_mapping`.
      label: tag.replace(/[_[\]]/g, ' ').replace(/\s+/g, ' ').trim(),
      enabled: !!row.enabled,
      kind: String(row.kind ?? 'base'),
    })
  }
  return rows
}

/** Turn a section on or off. */
export async function setSectionEnabled(tag: string, enabled: boolean): Promise<void> {
  const systems = await import('../engine/game-systems.js') as unknown as {
    setBaseSectionEnabled: (tag: string, enabled: boolean, settings: unknown) => void
  }
  const bits = await engine()
  systems.setBaseSectionEnabled(tag, enabled, bits.getSettings())
}

/**
 * Game Systems the user has defined — a custom prompt section plus, usually, a
 * tracked field, managed as one unit.
 */
export interface GameSystemRow {
  id: string
  name: string
  enabled: boolean
  description: string
}

export async function listGameSystems(): Promise<GameSystemRow[]> {
  const bits = await engine()
  const systems = bits.getSettings().gameSystems
  if (!Array.isArray(systems)) return []
  return systems.map((system: Record<string, any>) => ({
    id: String(system.id ?? ''),
    name: String(system.name ?? 'Untitled'),
    enabled: system.enabled !== false,
    description: String(system.description ?? ''),
  }))
}

export async function setGameSystemEnabled(id: string, enabled: boolean): Promise<boolean> {
  const bits = await engine()
  const settings = bits.getSettings()
  const system = (settings.gameSystems ?? []).find(
    (entry: Record<string, any>) => String(entry.id) === id,
  )
  if (!system) return false
  system.enabled = enabled
  // A Game System's prompt section rides on its library entry, so the two have
  // to agree or the section stays in the prompt with the system switched off.
  const linked = (settings.customSyspromptLibrary ?? []).find(
    (entry: Record<string, any>) => entry.id === system.syspromptLibraryId,
  )
  if (linked) linked.enabled = enabled
  return true
}
