/**
 * modules.ts — the Lorebook Agent's Modular Repertoire.
 *
 * The record types the agent may write — NPCs, locations, factions, quests,
 * events, world reports — and, for each, the field layout and the rule telling
 * the agent when to record one. `settings.routerModules` has been driving the
 * agent all along; there has simply been no way to see or change it.
 *
 * These rules are where most of the agent's behaviour actually lives. "ONLY
 * record a quest if the player unambiguously begins to pursue one" is the
 * difference between a useful quest log and a list of every rumour overheard in
 * a tavern, and it is one sentence in a settings object.
 *
 * The defaults are getters (`get instruction()` in `default-modules.js`), so
 * they are read fresh and never captured — several are assembled from other
 * settings, and a snapshot would go stale the moment one of those changed.
 */

interface EngineBits {
  getSettings: () => Record<string, any>
  DEFAULT_MODULES: Record<string, Record<string, any>>
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, defaults] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/state/default-modules.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    DEFAULT_MODULES: defaults.DEFAULT_MODULES,
  }
  return cached
}

export interface ModuleRow {
  id: string
  tag: string
  enabled: boolean
  format: string
  instruction: string
  isDefault: boolean
}

/** The live modules, falling back to the shipped set for anything missing. */
export async function listModules(): Promise<ModuleRow[]> {
  const bits = await engine()
  const settings = bits.getSettings()
  const live = settings.routerModules ?? {}

  const rows: ModuleRow[] = []
  // Iterate the defaults, not the stored object: a settings tree written by an
  // older version can be missing a module the engine now knows about, and that
  // module would silently never appear.
  for (const [id, fallback] of Object.entries(bits.DEFAULT_MODULES)) {
    const current = live[id] ?? {}
    const instruction = String(current.instruction ?? fallback.instruction ?? '')
    const format = String(current.format ?? fallback.format ?? '')
    rows.push({
      id,
      tag: String(current.tag ?? fallback.tag ?? id.toUpperCase()),
      enabled: current.enabled ?? fallback.enabled ?? true,
      format,
      instruction,
      isDefault: instruction === String(fallback.instruction ?? '')
        && format === String(fallback.format ?? ''),
    })
  }
  return rows
}

/** Change one module. Only the fields given are touched. */
export async function patchModule(
  id: string,
  patch: { enabled?: boolean; format?: string; instruction?: string },
): Promise<boolean> {
  const bits = await engine()
  const settings = bits.getSettings()
  const fallback = bits.DEFAULT_MODULES[id]
  if (!fallback) return false

  if (!settings.routerModules || typeof settings.routerModules !== 'object') {
    settings.routerModules = {}
  }
  const target = settings.routerModules[id] ?? (settings.routerModules[id] = {
    // Seed from the shipped module so a partial edit does not leave the agent
    // with a record type that has no tag or no rule.
    enabled: fallback.enabled,
    tag: fallback.tag,
    format: fallback.format,
    instruction: fallback.instruction,
  })

  if (typeof patch.enabled === 'boolean') target.enabled = patch.enabled
  if (typeof patch.format === 'string') target.format = patch.format
  if (typeof patch.instruction === 'string') target.instruction = patch.instruction
  return true
}

/** Put a module's shipped rule and layout back. */
export async function resetModule(id: string): Promise<boolean> {
  const bits = await engine()
  const settings = bits.getSettings()
  const fallback = bits.DEFAULT_MODULES[id]
  if (!fallback) return false

  const live = settings.routerModules?.[id]
  if (!live) return true
  // Read the getters now: several defaults are assembled from other settings.
  live.format = fallback.format
  live.instruction = fallback.instruction
  live.tag = fallback.tag
  return true
}
