/**
 * cyoa-history.ts — drop superseded `<choices>` blocks from the outgoing prompt.
 *
 * In CYOA mode the narrator ends every turn with a `<choices>` block, and the
 * frontend turns it into buttons. Those blocks stay in the chat forever, which
 * is right for the transcript and wrong for the prompt: by turn thirty the
 * model is re-reading twenty-six dead menus, paying for all of them, and taking
 * the oldest ones as formatting examples.
 *
 * Upstream keeps the four newest and strips the rest, on a disposable copy of
 * the prompt only — every choice stays visible and clickable in the chat. The
 * port does the same thing in the one place it has: the interceptor, which
 * already runs on an assembled prompt rather than on the stored chat, so there
 * is no copy to be careful about here.
 *
 * The stripping itself is `stripSupersededChoicesFromChatPrompt` verbatim from
 * the engine — it takes an OpenAI-shaped chat array, which is exactly what a
 * Lumiverse interceptor is handed.
 */

import type { LlmMessageDTO } from 'lumiverse-spindle-types'

interface EngineBits {
  getSettings: () => Record<string, any>
  isEffectiveSectionEnabled: (tag: string, settings: unknown) => boolean
  stripSupersededChoicesFromChatPrompt: (chat: unknown[]) => unknown[]
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, sections, history] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/state/section-enabled.js'),
    import('../engine/src/features/cyoa-prompt-history.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    isEffectiveSectionEnabled: sections.isEffectiveSectionEnabled,
    stripSupersededChoicesFromChatPrompt: history.stripSupersededChoicesFromChatPrompt,
  }
  return cached
}

/**
 * Whether to strip on this generation.
 *
 * Deliberately does *not* require `settings.enabled`, matching upstream: if you
 * power the framework down mid-campaign, the choice blocks already in the chat
 * would otherwise keep steering the model with menus nothing can answer.
 */
function shouldStrip(settings: Record<string, any>, bits: EngineBits): boolean {
  if (!bits.isEffectiveSectionEnabled('CYOA_mode', settings)) return false
  return settings.cyoaConfig?.stripOldChoicesFromPrompt !== false
}

/**
 * Return the prompt with all but the four newest `<choices>` blocks removed
 * from assistant turns.
 *
 * Only assistant content is eligible, which is the whole reason upstream drew
 * the line there: the CYOA instruction block carries two worked `<choices>`
 * examples and the engine prepends it to the *user* message, so restricting the
 * sweep to assistant turns is what keeps the model's own instructions intact.
 * It also leaves a player who typed `<choices>` at the narrator alone.
 */
export async function stripSupersededChoices(
  messages: LlmMessageDTO[],
): Promise<LlmMessageDTO[]> {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  try {
    const bits = await engine()
    if (!shouldStrip(bits.getSettings(), bits)) return messages
    return bits.stripSupersededChoicesFromChatPrompt(messages) as LlmMessageDTO[]
  } catch (error) {
    // Trimming is an economy, never a reason to lose someone's turn.
    spindle.log.warn(`[DnD] choice-block trimming skipped: ${(error as Error).message}`)
    return messages
  }
}
