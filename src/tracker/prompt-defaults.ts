/**
 * prompt-defaults.ts — telling you when an update changed the shipped prompts.
 *
 * The extension ships around 25 KB of prompt text: the narrator's ruleset, the
 * State Tracker's core prompt, the Lorebook Agent's per-module instructions, the
 * map prompts, the NPC/PC section schemas. An update can change any of them, and
 * anyone who has edited those prompts now has a choice to make.
 *
 * Upstream makes the choice explicit: it fingerprints the shipped defaults, and
 * on the first load after they change it shows what moved, with a per-line diff
 * and a badge saying whether *your* copy still matches the old shipped text or
 * you have edited it. This port had none of that — the fingerprint was in the
 * defaults, nothing read it, and updated prompts either overwrote silently or
 * did not arrive at all depending on which key the user had touched.
 *
 * ## What it does not do
 *
 * Upstream's dialog also offers "Save as Cartridge & Update All". That is
 * available here as its own button in the Cartridges tab and it works, so the
 * dialog links to the idea rather than reimplementing it inline — one flow that
 * snapshots a configuration is better than two.
 *
 * ## The badge is the point
 *
 * "This changed" is not actionable on its own. `getPromptCategoryImpactBadge`
 * answers the question that is: does the copy you are running still match what
 * shipped before, or have you edited it? If it matches, taking the update costs
 * nothing. If you edited it, the update would throw your work away — and that is
 * exactly when you want to be asked rather than told.
 */

import { saveSettings } from '../compat/settings-store'

interface EngineBits {
  getSettings: () => Record<string, any>
  buildBundledPromptsSnapshot: () => Record<string, any>
  normalizeBundledPromptsSnapshot: (snapshot: unknown) => Record<string, any>
  computeBundledPromptsFingerprint: () => string
  computeBundledPromptsFingerprintForSnapshot: (snapshot: unknown) => string
  getSnapshotCategoryBlocks: (
    snapshot: unknown,
    category: string,
  ) => Array<{ label: string; text: string }>
  getPromptCategoryImpactBadge: (
    oldSnapshot: unknown,
    newSnapshot: unknown,
    settings: unknown,
    category: string,
    options?: Record<string, unknown>,
  ) => string
  PROMPT_DEFAULTS_CATEGORIES: readonly string[]
  PROMPT_DEFAULTS_CATEGORY_LABELS: Record<string, string>
  diffTextLines: (
    oldText: string,
    newText: string,
    options?: Record<string, unknown>,
  ) => { lines: Array<{ type: string; text: string }>; additions: number; deletions: number; truncated: boolean; omitted: number }
  diffHasChanges: (diff: unknown) => boolean
  DEFAULT_STOCK_PROMPTS: Record<string, unknown>
  DEFAULT_MODULES: Record<string, any>
  DEFAULT_NPC_SECTIONS: unknown[]
  DEFAULT_PC_SECTIONS: unknown[]
  buildNpcInstruction: (
    major: unknown,
    minor: unknown,
    flag: boolean,
    settings: unknown,
  ) => string
  resetLorebookPromptTemplates: (settings: unknown, scope: string) => unknown
  refreshCyoaConfigToShipped?: (config: unknown, options?: Record<string, unknown>) => unknown
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, diff, constants] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/prompt-diff.js'),
    import('../engine/constants.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    buildBundledPromptsSnapshot: stateManager.buildBundledPromptsSnapshot,
    normalizeBundledPromptsSnapshot: stateManager.normalizeBundledPromptsSnapshot,
    computeBundledPromptsFingerprint: stateManager.computeBundledPromptsFingerprint,
    computeBundledPromptsFingerprintForSnapshot:
      stateManager.computeBundledPromptsFingerprintForSnapshot,
    getSnapshotCategoryBlocks: stateManager.getSnapshotCategoryBlocks,
    getPromptCategoryImpactBadge: stateManager.getPromptCategoryImpactBadge,
    PROMPT_DEFAULTS_CATEGORIES: stateManager.PROMPT_DEFAULTS_CATEGORIES,
    PROMPT_DEFAULTS_CATEGORY_LABELS: stateManager.PROMPT_DEFAULTS_CATEGORY_LABELS,
    diffTextLines: diff.diffTextLines,
    diffHasChanges: diff.diffHasChanges,
    DEFAULT_STOCK_PROMPTS: constants.DEFAULT_STOCK_PROMPTS,
    DEFAULT_MODULES: stateManager.DEFAULT_MODULES,
    DEFAULT_NPC_SECTIONS: stateManager.DEFAULT_NPC_SECTIONS,
    DEFAULT_PC_SECTIONS: stateManager.DEFAULT_PC_SECTIONS,
    buildNpcInstruction: stateManager.buildNpcInstruction,
    resetLorebookPromptTemplates: stateManager.resetLorebookPromptTemplates,
    refreshCyoaConfigToShipped: constants.refreshCyoaConfigToShipped,
  }
  return cached
}

export interface PromptDiffBlock {
  label: string
  additions: number
  deletions: number
  truncated: boolean
  /** Unified-ish lines, already capped by the engine's display limits. */
  lines: Array<{ type: string; text: string }>
}

export interface PromptCategoryChange {
  id: string
  label: string
  /** `customized` | `matches new` | `matches old` | `unknown`. */
  badge: string
  blocks: PromptDiffBlock[]
}

export interface PromptDefaultsReport {
  /** Whether anything shipped has changed since this install last looked. */
  pending: boolean
  reason?: string
  changed: PromptCategoryChange[]
}

/**
 * Compare the shipped prompts with the snapshot this install acknowledged.
 *
 * Three states get acknowledged silently rather than shown, all of them
 * upstream's: a fresh install (there is nothing to have changed *from*), an
 * install predating fingerprint tracking (adopting the current text quietly
 * beats claiming everything changed), and a snapshot whose fingerprint already
 * matches under the current format.
 */
export async function checkPromptDefaults(): Promise<PromptDefaultsReport> {
  const bits = await engine()
  try {
    const settings = bits.getSettings()
    const currentSnapshot = bits.buildBundledPromptsSnapshot()
    const currentFingerprint = bits.computeBundledPromptsFingerprintForSnapshot(currentSnapshot)

    const rawStored = settings.lastSeenPromptDefaultsSnapshot || null
    const storedSnapshot = rawStored ? bits.normalizeBundledPromptsSnapshot(rawStored) : null
    const storedFingerprint = storedSnapshot
      ? bits.computeBundledPromptsFingerprintForSnapshot(storedSnapshot)
      : String(settings.lastSeenPromptDefaultsFingerprint || '')

    if (!storedFingerprint) {
      // Nothing to compare against. Adopt quietly — a first run must not open
      // with a dialog about changes the user has never seen.
      await acknowledgePromptDefaults()
      return { pending: false, reason: 'first run — shipped defaults recorded', changed: [] }
    }
    if (storedFingerprint === currentFingerprint) {
      // Format-neutral fingerprints can agree while the stored copy is older;
      // re-stamp so the comparison stays cheap next time.
      if (settings.lastSeenPromptDefaultsFingerprint !== currentFingerprint) {
        await acknowledgePromptDefaults()
      }
      return { pending: false, changed: [] }
    }

    const changed: PromptCategoryChange[] = []
    for (const category of bits.PROMPT_DEFAULTS_CATEGORIES) {
      const oldBlocks = bits.getSnapshotCategoryBlocks(storedSnapshot, category)
      const newBlocks = bits.getSnapshotCategoryBlocks(currentSnapshot, category)
      const labels = new Set([
        ...oldBlocks.map(block => block.label),
        ...newBlocks.map(block => block.label),
      ])

      const blocks: PromptDiffBlock[] = []
      for (const label of labels) {
        const oldText = oldBlocks.find(block => block.label === label)?.text ?? ''
        const newText = newBlocks.find(block => block.label === label)?.text ?? ''
        if (oldText === newText) continue
        const diff = bits.diffTextLines(oldText, newText)
        if (!bits.diffHasChanges(diff)) continue
        blocks.push({
          label,
          additions: diff.additions,
          deletions: diff.deletions,
          truncated: diff.truncated,
          lines: diff.lines,
        })
      }
      if (!blocks.length) continue

      changed.push({
        id: category,
        label: bits.PROMPT_DEFAULTS_CATEGORY_LABELS[category] ?? category,
        badge: bits.getPromptCategoryImpactBadge(
          storedSnapshot, currentSnapshot, settings, category,
        ),
        blocks,
      })
    }

    if (!changed.length) {
      // The fingerprint moved but nothing a user can see did — a formatting
      // change in the snapshot itself. Adopt it silently.
      await acknowledgePromptDefaults()
      return { pending: false, changed: [] }
    }

    return { pending: true, changed }
  } catch (error) {
    spindle.log.error(`[DnD] prompt defaults check failed: ${(error as Error).message}`)
    return { pending: false, reason: (error as Error).message, changed: [] }
  }
}

/**
 * Record the current shipped prompts as seen.
 *
 * Persisted immediately rather than through the debounced save: this is what
 * decides whether the dialog reappears, and a reload during the debounce window
 * would resurrect a dialog the user has already answered.
 */
export async function acknowledgePromptDefaults(): Promise<void> {
  const bits = await engine()
  const settings = bits.getSettings()
  settings.lastSeenPromptDefaultsSnapshot = bits.buildBundledPromptsSnapshot()
  settings.lastSeenPromptDefaultsFingerprint =
    bits.computeBundledPromptsFingerprintForSnapshot(settings.lastSeenPromptDefaultsSnapshot)
  await saveSettings()
}

export interface PromptApplyResult {
  ok: boolean
  reason?: string
  /** Categories that were actually reset. */
  applied: string[]
}

/**
 * Take the new shipped defaults for the named categories, and leave the rest.
 *
 * Each branch mirrors upstream's, minus the jQuery that pushed the new value
 * into a textarea — the settings surface here re-reads from the tree, so the
 * write is the whole job.
 */
export async function applyPromptDefaults(categories: string[]): Promise<PromptApplyResult> {
  const bits = await engine()
  const wanted = new Set(
    (Array.isArray(categories) ? categories : [])
      .filter(id => bits.PROMPT_DEFAULTS_CATEGORIES.includes(id)),
  )
  if (!wanted.size) {
    // Still an acknowledgement: "keep mine" is an answer, and the dialog must
    // not come back every load because of it.
    await acknowledgePromptDefaults()
    return { ok: true, applied: [] }
  }

  const settings = bits.getSettings()
  const applied: string[] = []

  try {
    if (wanted.has('sysprompt')) {
      // Deleting the override is what "take the shipped text" means here: the
      // ruleset is assembled per generation from the bundled sections, so there
      // is no textarea to repopulate.
      settings.customSysprompt = false
      delete settings.customSyspromptText
      if (!settings.cyoaConfig) settings.cyoaConfig = {}
      // CYOA lives in cyoaConfig and is injected into the user message, so it
      // does not come along with the ruleset unless it is refreshed explicitly.
      bits.refreshCyoaConfigToShipped?.(settings.cyoaConfig, { resetSlots: true })
      applied.push('sysprompt')
    }

    if (wanted.has('tracker')) {
      delete settings.systemPromptTemplate
      delete settings.userPromptSuffix
      settings.stockPrompts = JSON.parse(JSON.stringify(bits.DEFAULT_STOCK_PROMPTS))
      applied.push('tracker')
    }

    // Core sections before Lorebook, so the NPC instruction rebuild below sees
    // the new schemas rather than the old ones.
    if (wanted.has('sections')) {
      settings.npcCoreSections = JSON.parse(JSON.stringify(bits.DEFAULT_NPC_SECTIONS))
      settings.pcCoreSections = JSON.parse(JSON.stringify(bits.DEFAULT_PC_SECTIONS))
      if (!wanted.has('lorebook') && settings.routerModules?.npc) {
        settings.routerModules.npc.instruction = bits.buildNpcInstruction(
          settings.npcMajorWords, settings.npcMinorWords, false, settings,
        )
      }
      applied.push('sections')
    }

    if (wanted.has('lorebook')) {
      bits.resetLorebookPromptTemplates(settings, 'all')
      for (const [id, definition] of Object.entries(bits.DEFAULT_MODULES)) {
        const module = settings.routerModules?.[id]
        if (!module) continue
        module.instruction = id === 'npc'
          ? bits.buildNpcInstruction(
            settings.npcMajorWords, settings.npcMinorWords, false, settings,
          )
          : definition.instruction
        module.format = definition.format
      }
      applied.push('lorebook')
    }

    if (wanted.has('world')) {
      for (const key of [
        'mapArchitectSystemPrompt',
        'mapUpdaterSystemPrompt',
        'mapEvolutionSystemPrompt',
        'mapEvolutionCompressSystemPrompt',
        'worldProgressionSystemPrompt',
        'worldProgressionSkeletonSystemPrompt',
      ]) {
        delete settings[key]
      }
      applied.push('world')
    }

    await acknowledgePromptDefaults()
    return { ok: true, applied }
  } catch (error) {
    spindle.log.error(`[DnD] applying prompt defaults failed: ${(error as Error).message}`)
    return { ok: false, reason: (error as Error).message, applied }
  }
}
