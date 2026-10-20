/**
 * port-defaults.ts — engine defaults the port changes, for new installs only.
 *
 * The engine's defaults are upstream's (`src/engine/src/state/defaults.js`,
 * generated — never edited). Where the port wants a different starting point,
 * it is listed here and applied once, when a user's settings are first
 * created. Existing users keep what they have: switching a feature off under
 * someone mid-campaign would be worse than the default it fixes.
 */

import { writePath } from '../shared/settings-schema'

/** The key the engine keeps its settings under in `extensionSettings`. */
export const ENGINE_SETTINGS_KEY = 'rpg_tracker'

export const PORT_DEFAULTS: ReadonlyArray<{ path: string; value: unknown; why: string }> = [
  {
    // The master switch for the whole map system: the ~1.7k-token dungeon
    // ruleset module on every prompt, the Map Architect, the updater and
    // evolution passes. Most campaigns never need it, and it was the largest
    // single cost in the narrator ruleset. One toggle turns it all back on.
    path: 'syspromptModules.dungeon_reality_and_hidden_mapping',
    value: false,
    why: 'persistent maps are opt-in',
  },
]

export function applyPortDefaults(settings: Record<string, unknown>): string[] {
  const applied: string[] = []
  for (const { path, value } of PORT_DEFAULTS) {
    writePath(settings, path, value)
    applied.push(path)
  }
  return applied
}
