/**
 * auto-art.ts — portraits and location art drawn without being asked.
 *
 * Upstream's Auto-Generate options draw a portrait for each newcomer — your
 * character, a party member, an enemy, an NPC in the campaign's lorebook — and
 * scene art for each lorebook location, as they appear. All of the logic is
 * the engine's (`checkAndTriggerAutoGenerations` and friends): which names are
 * new, a queue that draws one image at a time, a guard that drops the result
 * if the user has left the chat. Only the call was missing. Upstream makes it
 * at the end of every render, from `index.js`, which the port replaces.
 *
 * Every image is a paid call, so every option starts **off**, and with all of
 * them off nothing here runs at all — not even the bookkeeping. The images go
 * through the host's image generation via the engine's `/imagine` path; see
 * `compat/image-gen.ts`.
 *
 * Two things the port adds around the engine's check:
 *
 *   - **No connection, no prompts.** Each portrait starts with a model call
 *     that writes its description. Without an image connection that call is
 *     wasted and the image call then fails, once per character, so nothing
 *     starts until the host can actually draw — and the user hears why, once.
 *   - **One check at a time.** A turn repaints the panel several times, and
 *     each check lists the image connections and may read the NPC lorebook.
 *     A burst collapses to the check running plus one more. (The engine's
 *     first-check bookkeeping is synchronous, so overlapping checks were never
 *     a correctness problem — only wasted work.)
 */

export const AUTO_ART_KEYS = [
  'portraitAutoGeneratePlayer',
  'portraitAutoGenerateParty',
  'portraitAutoGenerateEnemies',
  'portraitAutoGenerateNpcs',
  'portraitAutoGenerateLocations',
] as const

export interface AutoArtDeps {
  /** Repaint after a picture lands. The engine has already saved it. */
  refresh: () => void
  /** Tell the user something they need to act on. */
  warn: (message: string) => void
}

/** Whether any automatic art is switched on. */
export function autoArtOn(settings: Record<string, unknown>): boolean {
  if (settings.enablePortraits === false) return false
  return AUTO_ART_KEYS.some(key => settings[key] === true)
}

let chain: Promise<void> = Promise.resolve()
let checkWaiting = false
let warnedUnavailable = false

async function run(deps: AutoArtDeps, force: boolean): Promise<void> {
  try {
    const [stateManager, portraits, imageGen] = await Promise.all([
      import('../engine/state-manager.js'),
      import('../engine/portraits.js'),
      import('../compat/image-gen'),
    ]) as any[]
    if (!autoArtOn(stateManager.getSettings())) return
    const available = await imageGen.imageGenAvailable()
    if (!available.ok) {
      // Once per session, not once per reply.
      if (!warnedUnavailable) {
        warnedUnavailable = true
        deps.warn(`Automatic art is on, but nothing was drawn: ${available.reason}.`)
      }
      return
    }
    warnedUnavailable = false
    if (force) await portraits.forceCheckAutoGenerations(deps.refresh)
    else await portraits.checkAndTriggerAutoGenerations(deps.refresh)
  } catch (error) {
    spindle.log.warn(`[DnD] automatic art check failed: ${(error as Error).message}`)
  }
}

/**
 * Draw whatever is new since the last check. Called after every repaint, as
 * upstream does. A burst of calls collapses to the one running plus one more,
 * which reads the newest state when it starts.
 */
export function checkAutoArt(deps: AutoArtDeps): Promise<void> {
  if (checkWaiting) return chain
  checkWaiting = true
  chain = chain.then(() => {
    checkWaiting = false
    return run(deps, false)
  })
  return chain
}

/**
 * Draw everyone the switched-on options cover who has no picture yet, new or
 * not — upstream does this the moment an Auto-Generate option is turned on.
 */
export function forceAutoArt(deps: AutoArtDeps): Promise<void> {
  chain = chain.then(() => run(deps, true))
  return chain
}
