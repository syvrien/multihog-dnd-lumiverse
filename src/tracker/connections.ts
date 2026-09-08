/**
 * connections.ts — which model each subsystem talks to.
 *
 * Upstream gives Character Creation, the Map Architect, the map runtime and
 * Map Evolution each their own connection, all defaulting to
 * `connectionSource: 'default'` — SillyTavern's "main API". There is no main
 * API here, so an unconfigured subsystem sends a request with no model and the
 * provider answers "Missing or invalid required parameter: model".
 *
 * The port's answer has always been to fall back to the tracker's own
 * connection rather than making the user configure four. That was written as a
 * one-shot:
 *
 *     if (source !== 'profile' || !profileId) { copy the tracker's }
 *
 * which is wrong in a way that only shows up later. The copy sets
 * `source = 'profile'`, so the *next* call sees a pinned profile and leaves it
 * alone — the inherited value has become indistinguishable from a deliberate
 * choice. Change the tracker's connection afterwards and character creation
 * quietly keeps using the old model, for good.
 *
 * So inheritance is recorded rather than inferred. `<prefix>ConnectionFollows`
 * marks a connection as inherited; it stays live until the user picks one, and
 * picking one sets it false.
 */

/** Subsystems with their own connection, keyed by settings prefix. */
export const CONNECTION_PREFIXES = [
  'characterCreation',
  'mapArchitect',
  'mapRuntime',
  'mapEvolution',
  'adventureCompanion',
  // The Lorebook Agent. Missing from this list until it was noticed that every
  // agent pass had been failing with "Missing or invalid required parameter:
  // model" — the pass logs its own failure and the tracker carries on, so the
  // only symptom was an agent that never wrote anything on its own.
  'router',
  // World Progression is driven from `onGenerationEnded` like the map passes,
  // so it would have hit the same wall the moment anyone switched it on.
  'world',
  // Not wired yet, but they carry the same broken default, and a connection
  // that follows the tracker is the right answer whenever they are.
  'gameSystemWizard',
  'portrait',
] as const

export type ConnectionPrefix = typeof CONNECTION_PREFIXES[number]

const sourceKey = (prefix: string): string => `${prefix}ConnectionSource`
const profileKey = (prefix: string): string => `${prefix}ConnectionProfileId`
/** Not an upstream key. Absent means "still following", which is the default. */
const followsKey = (prefix: string): string => `${prefix}ConnectionFollows`

/**
 * Mark a subsystem's connection as deliberately chosen, so it stops following
 * the tracker. Called when the user picks one.
 */
export function pinConnection(settings: Record<string, any>, prefix: string): void {
  if (!prefix) return
  settings[followsKey(prefix)] = false
}

/**
 * Point every following subsystem at the tracker's connection.
 *
 * Idempotent, and safe to call on every boot and every settings change.
 *
 * @returns the prefixes that were (re)pointed.
 */
export function inheritConnections(settings: Record<string, any>): string[] {
  const source = settings.connectionSource
  const profileId = settings.connectionProfileId
  const changed: string[] = []

  for (const prefix of CONNECTION_PREFIXES) {
    // An explicit pick wins. Absent means following: a user of this port has
    // never had a working settings surface for these, so there is no
    // deliberate choice to mistake it for.
    if (settings[followsKey(prefix)] === false) continue
    if (settings[sourceKey(prefix)] === source
      && settings[profileKey(prefix)] === profileId) {
      continue
    }
    settings[sourceKey(prefix)] = source
    settings[profileKey(prefix)] = profileId
    settings[followsKey(prefix)] = true
    changed.push(prefix)
  }
  return changed
}
