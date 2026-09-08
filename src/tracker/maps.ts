/**
 * maps.ts — turning the persistent-map subsystem on.
 *
 * This is a wiring slice, not a port. `map-architect.js`, `map-updater.js` and
 * `map-evolution.js` all came across in the tracker closure, and
 * `onGenerationEnded()` already calls the updater and the evolution pass on
 * every turn. They did nothing because a map has to exist first, and the only
 * thing that creates one is a **tool call**: the narrator model calls
 * `CreateAreaMap`, which runs the Map Architect.
 *
 * That tool is registered by `syncLocationMappingRuntime()` in
 * `narrative-hooks.js`, which upstream's `index.js` calls at boot and on every
 * settings change. The port replaces `index.js` and never called it, so the
 * tool was never offered to the model and no map could ever come into being.
 *
 * The second half is the connection. All three subsystems default to
 * `connectionSource: 'default'`, which is SillyTavern's "main API" — the same
 * trap that made character creation generate against nothing, twice. There is
 * no main API here, so they fall back to the tracker's own connection.
 */

interface EngineBits {
  getSettings: () => Record<string, any>
  isLocationMappingEnabled: (settings: unknown) => boolean
  syncLocationMappingRuntime: () => void
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, section, hooks] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/state/section-enabled.js'),
    import('../engine/narrative-hooks.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    isLocationMappingEnabled: section.isLocationMappingEnabled,
    syncLocationMappingRuntime: hooks.syncLocationMappingRuntime,
  }
  return cached
}

export { inheritConnections } from './connections'

export interface MapStatus {
  /** Whether Persistent Maps is on — the master gate for all three passes. */
  enabled: boolean
  /** Whether `CreateAreaMap` is now offered to the narrator model. */
  toolRegistered: boolean
  reason?: string
}

/**
 * Register or unregister the Map Architect tool to match the settings.
 *
 * Safe to call repeatedly: `syncLocationMappingRuntime()` unregisters first,
 * and aborts any updater or evolution pass in flight when mapping is off. So
 * this is also how a settings change takes effect.
 */
export async function syncMapRuntime(): Promise<MapStatus> {
  if (!spindle.permissions.has('tools')) {
    return {
      enabled: false,
      toolRegistered: false,
      reason: '"tools" not granted — the model cannot be offered CreateAreaMap',
    }
  }
  if (!spindle.permissions.has('world_books')) {
    return {
      enabled: false,
      toolRegistered: false,
      reason: '"world_books" not granted — a map has nowhere to be saved',
    }
  }

  const bits = await engine()
  const settings = bits.getSettings()

  const { inheritConnections } = await import('./connections')
  const redirected = inheritConnections(settings)
  if (redirected.length && settings.debugMode) {
    spindle.log.info(`[DnD] connections following the tracker: ${redirected.join(', ')}`)
  }

  const enabled = bits.isLocationMappingEnabled(settings)
  try {
    bits.syncLocationMappingRuntime()
  } catch (error) {
    return {
      enabled,
      toolRegistered: false,
      reason: `map runtime sync failed: ${(error as Error).message}`,
    }
  }

  const { registeredToolNames } = await import('../compat/tools')
  const toolRegistered = registeredToolNames().includes('CreateAreaMap')

  if (!enabled) {
    return {
      enabled: false,
      toolRegistered,
      reason: settings.enabled === false
        ? 'the tracker is switched off'
        : 'Persistent Maps is switched off',
    }
  }
  if (!toolRegistered) {
    // `registerMapArchitectTool` also bails when the text-opener mode is on,
    // which is a deliberate upstream configuration rather than a failure.
    return {
      enabled: true,
      toolRegistered: false,
      reason: 'the Map Architect tool did not register — text-opener mode may be on',
    }
  }
  return { enabled: true, toolRegistered: true }
}

/** Settings keys that change what `syncMapRuntime()` would do. */
export function affectsMapRuntime(keys: string[]): boolean {
  return keys.some(key =>
    key.startsWith('map')
    || key === 'enabled'
    || key.startsWith('connection')
    || key === 'syspromptModules.dungeon_reality_and_hidden_mapping')
}
