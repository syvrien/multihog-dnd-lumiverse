/**
 * cartridges.ts — a whole configuration, saved and swapped.
 *
 * Everything the framework has been taught: the narrator ruleset and its
 * section order, Game Systems and custom tracker fields, the agent's record
 * types, CYOA setup, dice and time flags. A cartridge is a named snapshot of
 * all of it, exportable as JSON and loadable back.
 *
 * The point is that configuring this framework is real work. A grim-survival
 * setup and a lighthearted one differ across a dozen settings, and without
 * cartridges the only way to keep both is to remember which switches to flip.
 *
 * ## Selective restore is the important half
 *
 * `applyCartridgePayload` replaces every field. That is rarely what a person
 * wants — they took a cartridge for its Game Systems and would like to keep
 * their own dice settings. `CARTRIDGE_PAYLOAD_GROUPS` divides the payload into
 * labelled groups, and restoring a subset leaves everything else untouched.
 *
 * ## What a cartridge is not
 *
 * It carries **configuration, never a playthrough** — no chat state, no memo,
 * no lorebook entries. Sharing one hands over your setup, not your campaign.
 * That boundary is the engine's; this layer does not widen it.
 */

export interface CartridgeGroup {
  id: string
  label: string
  description: string
  /** Whether this group differs from the shipped defaults. */
  changed: boolean
}

export interface CartridgeRow {
  id: string
  name: string
  description: string
  icon: string
  updatedAt: number
}

interface EngineBits {
  getSettings: () => Record<string, any>
  groups: Array<{ id: string; label: string; description: string; keys: string[] }>
  factory: () => Record<string, unknown>
  build: (settings: unknown) => Record<string, unknown>
  applyKeys: (settings: unknown, payload: unknown, keys: string[]) => void
  createFromCurrent: (name: string, description: string, icon: string) => Record<string, any>
  uniqueName: (name: string, settings: unknown) => string
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, factoryAndDiff, cartridges] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/state/factory-and-diff.js'),
    import('../engine/game-cartridges.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    groups: factoryAndDiff.CARTRIDGE_PAYLOAD_GROUPS,
    factory: factoryAndDiff.getFactoryCartridgePayload,
    build: cartridges.buildCartridgePayload,
    applyKeys: cartridges.applyCartridgePayloadKeys,
    createFromCurrent: cartridges.createCartridgeFromCurrent,
    uniqueName: cartridges.uniqueCartridgeName,
  }
  return cached
}

/** The groups a payload divides into, flagged where they differ from stock. */
async function describeGroups(bits: EngineBits, payload: Record<string, unknown>): Promise<CartridgeGroup[]> {
  // "Stock" is what a new install starts with: upstream's factory settings,
  // plus the defaults the port changes. Otherwise every fresh install would
  // read as modified. See `compat/port-defaults.ts`.
  const factory = structuredClone(bits.factory())
  const { applyPortDefaults } = await import('../compat/port-defaults')
  applyPortDefaults(factory)
  return bits.groups.map(group => ({
    id: group.id,
    label: group.label,
    description: group.description,
    // Stock groups are worth marking: restoring one is a no-op, and knowing
    // that up front is the difference between a considered choice and a guess.
    changed: group.keys.some(
      key => JSON.stringify(payload[key]) !== JSON.stringify(factory[key]),
    ),
  }))
}

export async function listCartridges(): Promise<CartridgeRow[]> {
  const bits = await engine()
  const stored = bits.getSettings().gameCartridges
  if (!Array.isArray(stored)) return []
  return stored.map((entry: Record<string, any>) => ({
    id: String(entry.id ?? ''),
    name: String(entry.name ?? 'Untitled'),
    description: String(entry.description ?? ''),
    icon: String(entry.icon ?? '💾'),
    updatedAt: Number(entry.updatedAt ?? entry.createdAt ?? 0),
  })).sort((a, b) => a.name.localeCompare(b.name))
}

/** What is in a cartridge, before deciding what to take from it. */
export async function inspectCartridge(
  id: string,
): Promise<{ ok: boolean; groups?: CartridgeGroup[]; reason?: string }> {
  const bits = await engine()
  const found = (bits.getSettings().gameCartridges ?? []).find(
    (entry: Record<string, any>) => String(entry.id) === String(id),
  )
  if (!found) return { ok: false, reason: 'that cartridge no longer exists' }
  return { ok: true, groups: await describeGroups(bits, found.payload ?? {}) }
}

export async function saveCurrentAsCartridge(
  name: string,
  description: string,
  icon: string,
): Promise<{ ok: boolean; reason?: string }> {
  const label = String(name ?? '').trim()
  if (!label) return { ok: false, reason: 'name the cartridge' }
  const bits = await engine()
  try {
    bits.createFromCurrent(label, String(description ?? ''), String(icon ?? '💾'))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * Load some or all of a cartridge.
 *
 * `groupIds` empty means every group. Anything not named is left exactly as it
 * is — that is what makes taking one part of someone else's setup safe.
 */
export async function loadCartridge(
  id: string,
  groupIds: string[] = [],
): Promise<{ ok: boolean; applied?: string[]; reason?: string }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const found = (settings.gameCartridges ?? []).find(
    (entry: Record<string, any>) => String(entry.id) === String(id),
  )
  if (!found) return { ok: false, reason: 'that cartridge no longer exists' }

  const wanted = groupIds.length
    ? bits.groups.filter(group => groupIds.includes(group.id))
    : bits.groups
  if (!wanted.length) return { ok: false, reason: 'pick at least one thing to load' }

  try {
    bits.applyKeys(settings, found.payload ?? {}, wanted.flatMap(group => group.keys))
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  return { ok: true, applied: wanted.map(group => group.label) }
}

export async function deleteCartridge(id: string): Promise<{ ok: boolean; reason?: string }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const list = settings.gameCartridges ?? []
  const index = list.findIndex((entry: Record<string, any>) => String(entry.id) === String(id))
  if (index === -1) return { ok: false, reason: 'that cartridge no longer exists' }
  list.splice(index, 1)
  return { ok: true }
}

/** A cartridge as shareable JSON. */
export async function exportCartridge(
  id: string,
): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const bits = await engine()
  const found = (bits.getSettings().gameCartridges ?? []).find(
    (entry: Record<string, any>) => String(entry.id) === String(id),
  )
  if (!found) return { ok: false, reason: 'that cartridge no longer exists' }
  try {
    return {
      ok: true,
      text: JSON.stringify({
        format: 'multihog-game-cartridge',
        version: 1,
        name: found.name,
        description: found.description ?? '',
        icon: found.icon ?? '💾',
        payload: found.payload ?? {},
        exportedAt: Date.now(),
      }, null, 2),
    }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * Read a shared cartridge in.
 *
 * It is stored, not applied. A cartridge replaces configuration wholesale, and
 * importing one should never change how the game plays until the user says so.
 */
export async function importCartridge(
  text: string,
): Promise<{ ok: boolean; name?: string; reason?: string }> {
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch {
    return { ok: false, reason: 'that is not valid JSON' }
  }
  if (parsed?.format !== 'multihog-game-cartridge') {
    return { ok: false, reason: 'that JSON is not a Multihog cartridge' }
  }
  if (!parsed.payload || typeof parsed.payload !== 'object') {
    return { ok: false, reason: 'that cartridge has no settings in it' }
  }

  const bits = await engine()
  const settings = bits.getSettings()
  if (!Array.isArray(settings.gameCartridges)) settings.gameCartridges = []

  // Uniqued, so importing never silently replaces a cartridge you rely on.
  const name = bits.uniqueName(String(parsed.name || 'Imported Cartridge'), settings)
  settings.gameCartridges.push({
    id: `${Date.now()}`,
    name,
    description: String(parsed.description ?? ''),
    icon: String(parsed.icon ?? '💾'),
    payload: parsed.payload,
    format: 'multihog-game-cartridge',
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return { ok: true, name }
}

/** What the *current* configuration would look like as a cartridge. */
export async function describeCurrent(): Promise<CartridgeGroup[]> {
  const bits = await engine()
  return await describeGroups(bits, bits.build(bits.getSettings()))
}
