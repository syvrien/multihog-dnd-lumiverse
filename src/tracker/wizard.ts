/**
 * wizard.ts — the Game System Wizard.
 *
 * Describe a mechanic in a sentence — "radiation zones", "faction reputation",
 * "a farming sim with seasons" — and a model drafts both halves of a Game
 * System: the rules the narrator is given, and the tracker field that carries
 * the number.
 *
 * The drafting and the commit both come from the engine
 * (`generateGameSystemDraft`, `saveGameSystemFromPreview`), re-exported by the
 * port script. Only the multi-step UI is rebuilt, in `src/ui/wizard.ts`.
 *
 * ## Drivers
 *
 * A tracked value has to change *somehow*, and the wizard asks the model to
 * pick which: time (hunger ticking up with the clock), GM annotation (a
 * reputation the narrator declares moved), or a stated fact (a damage number
 * already written in the prose). At least one is required whenever the system
 * has a tracker, and `normalizeDrivers` in the engine enforces that — a system
 * with a field nothing updates would just sit at its starting value forever.
 */

import { inheritConnections } from './connections'

/** A drafted system, before the user has approved it. */
export interface WizardDraft {
  name: string
  icon: string
  description: string
  /** The rules given to the narrator. */
  includeGm: boolean
  gmTag: string
  gmContent: string
  /** The tracked field. */
  includeTracker: boolean
  trackerTag: string
  trackerLabel: string
  trackerIcon: string
  trackerContent: string
  driverTime: boolean
  driverGmAnnotation: boolean
  driverStatedFact: boolean
  effectOwner: 'tracker' | 'gm'
}

interface EngineBits {
  getSettings: () => Record<string, any>
  generateDraft: (
    settings: unknown,
    description: string,
    systemPrompt?: string,
    effectOwner?: string,
  ) => Promise<Record<string, any>>
  save: (result: Record<string, unknown>, existingId?: string | null) => boolean
  examples: Array<{ label: string; text: string }>
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, systems] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/game-systems.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    generateDraft: systems.generateGameSystemDraft,
    save: systems.saveGameSystemFromPreview,
    examples: systems.WIZARD_EXAMPLE_SYSTEMS ?? [],
  }
  return cached
}

/** Ready-made descriptions, so the box is not a blank page. */
export async function wizardExamples(): Promise<Array<{ label: string; text: string }>> {
  const bits = await engine()
  return bits.examples.map(example => ({
    label: String(example.label ?? ''),
    text: String(example.text ?? ''),
  }))
}

/**
 * Draft a system from a description. Nothing is saved.
 *
 * `effectOwner` decides who narrates a crossed threshold — the tracker stating
 * it plainly, or the narrator working it into the prose.
 */
export async function draftGameSystem(
  description: string,
  effectOwner: 'tracker' | 'gm' = 'tracker',
): Promise<{ ok: boolean; draft?: WizardDraft; reason?: string }> {
  const text = String(description ?? '').trim()
  if (!text) return { ok: false, reason: 'describe the mechanic first' }
  if (!spindle.permissions.has('generation')) {
    return { ok: false, reason: 'generation permission not granted' }
  }

  const bits = await engine()
  const settings = bits.getSettings()
  // The wizard has its own connection, defaulting to a "main API" that does not
  // exist here. See connections.ts.
  inheritConnections(settings)

  let parsed: Record<string, any>
  try {
    parsed = await bits.generateDraft(settings, text, undefined, effectOwner)
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
  if (!parsed) return { ok: false, reason: 'the model returned nothing usable' }

  return {
    ok: true,
    draft: {
      name: String(parsed.name ?? 'Custom System'),
      icon: String(parsed.icon ?? '✨'),
      description: text,
      includeGm: !!parsed.includeGm,
      gmTag: String(parsed.gmTag ?? ''),
      gmContent: String(parsed.gmContent ?? ''),
      // The engine calls this `needsTracker` on the way out and
      // `includeTracker` on the way back in.
      includeTracker: !!parsed.needsTracker,
      trackerTag: String(parsed.trackerTag ?? ''),
      trackerLabel: String(parsed.trackerLabel ?? parsed.name ?? ''),
      trackerIcon: String(parsed.trackerIcon ?? '📄'),
      trackerContent: String(parsed.trackerContent ?? ''),
      driverTime: !!parsed.driverTime,
      driverGmAnnotation: !!parsed.driverGmAnnotation,
      driverStatedFact: !!parsed.driverStatedFact,
      effectOwner: parsed.effectOwner === 'gm' ? 'gm' : 'tracker',
    },
  }
}

/**
 * Save an approved draft.
 *
 * `enable` decides whether the rules go into the narrator prompt now or sit in
 * the library until switched on.
 */
export async function saveGameSystem(
  draft: WizardDraft,
  enable: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  if (!draft?.includeGm && !draft?.includeTracker) {
    return { ok: false, reason: 'a system needs rules, a tracked field, or both' }
  }
  // A tracked value with nothing to move it never changes. The engine enforces
  // this too, but refusing here means the panel can say so before the save.
  if (draft.includeTracker
    && !draft.driverTime && !draft.driverGmAnnotation && !draft.driverStatedFact) {
    return { ok: false, reason: 'pick at least one thing that changes the value' }
  }

  const bits = await engine()
  try {
    const ok = bits.save({ ...draft, saveMode: enable ? 'apply' : 'library' }, null)
    return ok ? { ok: true } : { ok: false, reason: 'the engine refused the system' }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/** Remove a system, and the prompt section and field that belong to it. */
export async function deleteGameSystem(id: string): Promise<{ ok: boolean; reason?: string }> {
  const bits = await engine()
  const settings = bits.getSettings()
  const list = settings.gameSystems ?? []
  const index = list.findIndex((entry: Record<string, any>) => String(entry.id) === id)
  if (index === -1) return { ok: false, reason: 'that system no longer exists' }

  const [system] = list.splice(index, 1)
  // Leaving these behind would keep the rules in the narrator prompt and the
  // field on the tracker card, with nothing left to switch them off.
  if (system.syspromptLibraryId && Array.isArray(settings.customSyspromptLibrary)) {
    settings.customSyspromptLibrary = settings.customSyspromptLibrary.filter(
      (entry: Record<string, any>) => entry.id !== system.syspromptLibraryId,
    )
  }
  if (system.customFieldTag && Array.isArray(settings.customFields)) {
    settings.customFields = settings.customFields.filter(
      (entry: Record<string, any>) => entry.tag !== system.customFieldTag,
    )
  }
  return { ok: true }
}
