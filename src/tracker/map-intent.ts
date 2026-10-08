/**
 * map-intent.ts — fill a building before the narrator describes walking in.
 *
 * Upstream runs `onMapUpdaterUserMessage` on MESSAGE_SENT. SillyTavern awaits
 * that event before it assembles the narrator's prompt, so when the player
 * says they enter a BUILDING on the current map, the Map Updater gives it
 * contents first and the narration can use them. The port never subscribed.
 *
 * Lumiverse does not wait on MESSAGE_SENT, so running it there would race the
 * prompt. The interceptor is the moment the host *does* wait for, so the pass
 * runs from there, on a normal send only — not a swipe, a regenerate or a
 * continue, none of which upstream's MESSAGE_SENT would have seen.
 *
 * Nearly always this returns before any model call: the map updater must be
 * on, location mapping must be on, there must be an active map, and the
 * player's message must name one of its buildings that has nothing in it yet.
 */

import { chatMirror } from '../compat/chat-mirror'

export interface MapIntentOutcome {
  /** Why the engine was not asked, when it was not. */
  reason?: string
  /** What the engine's pass returned, when it was. */
  result?: unknown
}

/** The last outcome, for tests and the debug view. */
export let lastMapIntent: MapIntentOutcome | null = null

export async function mapIntentBeforeNarration(
  context: { generationType?: string; isDryRun?: boolean } | undefined,
): Promise<MapIntentOutcome> {
  const done = (outcome: MapIntentOutcome): MapIntentOutcome => (lastMapIntent = outcome)
  if (context?.isDryRun) return done({ reason: 'dry_run' })
  if (context?.generationType !== 'normal') return done({ reason: 'not_a_new_message' })
  try {
    const [stateManager, sections, updater, { withChatPinned }] = await Promise.all([
      import('../engine/state-manager.js'),
      import('../engine/src/state/section-enabled.js'),
      import('../engine/map-updater.js'),
      import('../compat/context'),
    ]) as any[]
    const settings = stateManager.getSettings()
    if (settings.mapUpdaterEnabled === false || !sections.isLocationMappingEnabled(settings)) {
      return done({ reason: 'maps_off' })
    }
    // The host announces the message before asking for the prompt, but the
    // two travel separately; read the chat if the mirror has not caught up.
    if (!chatMirror.messages.at(-1)?.is_user) await chatMirror.refresh()
    const index = chatMirror.messages.length - 1
    if (!chatMirror.messages[index]?.is_user) return done({ reason: 'not_a_user_message' })
    let result: unknown
    await withChatPinned(async () => {
      result = await updater.onMapUpdaterUserMessage(index)
    })
    return done({ result })
  } catch (error) {
    spindle.log.warn(`[DnD] map updater before narration failed: ${(error as Error).message}`)
    return done({ reason: 'failed' })
  }
}
