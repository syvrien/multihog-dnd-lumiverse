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

/**
 * Carry a clock-format change into everything that was written in the old one.
 *
 * `use24hTime` and `useDdMmYyFormat` are not display preferences: the stored
 * Lorebook Agent templates and stock prompts carry worked timestamps — "08:00
 * AM", "Day 3" — that teach the model which format to emit. Upstream funnels
 * both toggles through setters in `index.js` (the file the port replaces) that
 * rewrite those templates; the port's settings panel only flipped the flag. So
 * the tracker expected one clock and every agent prompt still demonstrated the
 * other — 13 AM/PM stamps and 16 "Day N" examples left behind on a fresh
 * install.
 *
 * This is `setUse24hTime` / `setUseDdMmYyFormat` without their DOM half, in
 * upstream's order. The caller saves afterwards, and the active chat's
 * partition — where the format is also stored — is rewritten here, as
 * upstream's `persistChatTimeFormatIfLinked()` does.
 */
export async function applyTimeFormatChange(
  settings: Record<string, any>,
  changed: { use24hTime?: boolean, useDdMmYyFormat?: boolean },
): Promise<void> {
  const bits = await engine()
  const [memoProcessor, constants, routerUtils] = await Promise.all([
    import('../engine/memo-processor.js'),
    import('../engine/constants.js'),
    import('../engine/src/state/router-utils.js'),
  ]) as any[]

  if (changed.useDdMmYyFormat) {
    // Only the untouched defaults are swapped. A start date someone typed is
    // theirs; upstream leaves it alone and so does this.
    if (settings.useDdMmYyFormat) {
      if (settings.initialDate === 'Day 1' || !settings.initialDate) settings.initialDate = '01/01/2026'
    } else if (!settings.initialDate
      || settings.initialDate === '01/01/2026' || settings.initialDate === '01/01/26') {
      settings.initialDate = 'Day 1'
    }
  }
  if (changed.use24hTime) {
    const minutes = memoProcessor.parseInWorldTime(settings.initialTime || '08:00 AM')
    if (minutes != null) {
      settings.initialTime = constants.formatTimeOfDay(minutes, !!settings.use24hTime)
    }
  }

  bits.rebuildAllModuleInstructions(settings)
  routerUtils.adjustAllStoredTemplatesForTimeFormat(settings)

  if (settings.chatLinkEnabled) {
    const { chatMirror } = await import('../compat/chat-mirror')
    const chatId = chatMirror.getChatId()
    if (chatId) {
      const persistence = await import('../engine/src/state/chat-persistence.js') as {
        saveChatState: (id: string) => unknown
      }
      persistence.saveChatState(chatId)
    }
  }
}
