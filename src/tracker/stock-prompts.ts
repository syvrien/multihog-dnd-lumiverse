/**
 * stock-prompts.ts — keeping derived prompt text in step with the settings.
 *
 * Two of the engine's runtime actions look like DOM chores and are not:
 *
 *   `refreshQuestPrompt`            rewrites the stored quest prompt
 *   `rebuildNpcInstructionIfNeeded` rebuilds the agent's module instructions
 *
 * Both were registered as no-ops in the port's runtime action table, alongside
 * the genuinely inert ones. The result was two settings that did nothing:
 * "Quest deadlines" left the DEADLINE rules in the prompt whether it was on or
 * off, and changing the relationship scale never reached the NPC instruction
 * the Lorebook Agent follows.
 *
 * `rebuildAllModuleInstructions` came across with the engine. `refreshQuestPrompt`
 * lives in `index.js` — the file the port replaces — so it is rebuilt here,
 * following upstream's edits exactly.
 */

interface EngineBits {
  getSettings: () => Record<string, any>
  DEFAULT_STOCK_PROMPTS: Record<string, string>
  rebuildAllModuleInstructions: (settings: unknown) => void
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, constants, moduleInstructions] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/constants.js'),
    import('../engine/src/state/module-instructions.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    DEFAULT_STOCK_PROMPTS: constants.DEFAULT_STOCK_PROMPTS,
    rebuildAllModuleInstructions: moduleInstructions.rebuildAllModuleInstructions,
  }
  return cached
}

/**
 * Rewrite the stored quest prompt for the current toggles.
 *
 * The prompt is always rebuilt from the shipped default rather than edited in
 * place, so turning a sub-feature off and on again restores the original text
 * instead of leaving whatever the last pass of regexes produced.
 */
export async function refreshQuestPrompt(settings?: Record<string, any>): Promise<void> {
  const bits = await engine()
  const s = settings ?? bits.getSettings()
  let prompt = bits.DEFAULT_STOCK_PROMPTS.quests ?? ''

  if (!s.syspromptModules?.questsDeadlines) {
    prompt = prompt
      .replace(/ {2}DEADLINE:.*\n/g, '')
      .replace(/- DEADLINE.*\n/g, '')
      .replace(/- DEADLINE \/ FRUSTRATION_COEFF:.*\n/g, '')
      .replace(/- Only use DEADLINE if the quest has a time limit\.\n/g, '')
  }
  if (!s.syspromptModules?.questsFrustration) {
    prompt = prompt
      .replace(/ {2}FRUSTRATION_COEFF:.*\n/g, '')
      .replace(/- On quest creation, set FRUSTRATION_COEFF.*\n/g, '')
      .replace(/- For NPC-given quests only[^\n]*\n/g, '')
      .replace(/- Omit FRUSTRATION_COEFF for emergent\/self-imposed quests[^\n]*\n/g, '')
      // Older combined line: keep the TYPE marker, drop the coefficient.
      .replace(
        /- For emergent\/self-imposed quests: set TYPE: emergent, use GIVER: Self @ —, and omit FRUSTRATION_COEFF entirely \(no NPC expects completion\)\.\n/g,
        '- For emergent/self-imposed quests: set TYPE: emergent and use GIVER: Self @ —.\n',
      )
  }

  if (!s.stockPrompts) s.stockPrompts = {}
  s.stockPrompts.quests = prompt
}

/** Rebuild the agent's module instructions from the current settings. */
export async function rebuildModuleInstructions(): Promise<void> {
  const bits = await engine()
  bits.rebuildAllModuleInstructions(bits.getSettings())
}
