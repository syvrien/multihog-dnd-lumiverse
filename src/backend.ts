/**
 * backend.ts — the Spindle backend entry.
 *
 * Boot order matters: the compat globals must exist before any engine module is
 * imported, because several of them call `SillyTavern.getContext()` while
 * initialising. Engine imports are therefore dynamic and happen after
 * `installCompatGlobals()`.
 */

import { installCompatGlobals } from './compat/install'
import { flushBrowserEnv, hydrateBrowserEnv, installBrowserEnv } from './compat/browser-env'
import {
  freshInstall, loadSettings, saveSettings, settingsLoaded, settingsLoadFailed,
} from './compat/settings-store'
import { bridgeHostEvents, event_types, eventSource } from './compat/events'
import { chatMirror } from './compat/chat-mirror'
import { invalidateWorldInfoCache, updateWorldInfoList } from './compat/world-info'
import { cancelAllPopups, resolvePopup, setPopupUser } from './compat/popup-bridge'
import { invalidateConnectionCache } from './compat/llm'
import { registeredToolNames, unregisterAllTools } from './compat/tools'
import { installEngineHooks, removeEngineHooks } from './compat/engine-hooks'
import {
  loadActiveCharacter,
  loadActivePersona,
  loadChatMetadata,
  setActiveChat,
} from './compat/context'
import {
  applyUnlinkedSwitch,
  loadChatState,
  resetUnseenChatState,
  saveChatStateFor,
  snapshotPortraitsFor,
} from './compat/chat-state'
import { invalidateChatCommitGuards } from './engine/src/state/pass-affinity.js'
import { onUserResolved, setActiveUser, userScope } from './compat/user-context'
import { flushRuntimeActions, installRuntimeActions } from './compat/runtime-actions'
import { stripSupersededChoices } from './tracker/cyoa-history'
import { roleForStMessage, type StMessage } from './compat/chat-mirror'
import type { InterceptorContextDTO, LlmMessageDTO } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from './shared/protocol'
import {
  LOOKBACK_MODE_KEY,
  lookbackModeFrom,
  lookbackModeTo,
  prefixForProfileKey,
  writePath,
} from './shared/settings-schema'

type TrackerInterceptor = (
  chat: Partial<StMessage>[],
  contextSize: number,
  abort: (reason?: unknown) => void,
  type: string,
) => Promise<void> | void

const teardowns: Array<() => void> = []

let userStateReady: Promise<void> | null = null
/** The read-only warning has been shown for the current run of failed loads. */
let settingsWarningShown = false

/**
 * Load everything that belongs to the current user: their stored preferences
 * and their settings tree.
 *
 * Idempotent and awaited from every entry point that needs settings, because
 * the first thing to happen after boot might be a generation rather than a
 * chat switch — and the interceptor must not run against empty defaults just
 * because it won the race.
 */
function ensureUserState(): Promise<void> {
  if (userStateReady) return userStateReady
  userStateReady = (async () => {
    await hydrateBrowserEnv()
    try {
      await loadSettings()
    } catch (error) {
      // Saving is suspended until a read succeeds; say so once, not on every
      // entry point that retries.
      if (settingsLoadFailed() && !settingsWarningShown) {
        settingsWarningShown = true
        send({
          type: 'toast', level: 'warning',
          message: 'DnD settings could not be loaded. Changes will not be saved until they can be read — '
            + 'reload the page to try again.',
        })
      }
      throw error
    }
    settingsWarningShown = false
    // First run: start from the port's defaults where they differ from
    // upstream's — persistent maps off, for one. Existing users keep theirs.
    if (freshInstall()) {
      const [{ applyPortDefaults }, stateManager] = await Promise.all([
        import('./compat/port-defaults'),
        import('./engine/state-manager.js') as Promise<{ getSettings: () => Record<string, unknown> }>,
      ])
      const applied = applyPortDefaults(stateManager.getSettings())
      spindle.log.info(`[DnD] new install: applied port defaults (${applied.join(', ')})`)
      await saveSettings()
    }
    void eventSource.emit(event_types.SETTINGS_LOADED)
  })().catch(error => {
    // Let a later call retry rather than caching the failure forever.
    userStateReady = null
    spindle.log.error(`[DnD] loading user state failed: ${(error as Error).message}`)
  })
  return userStateReady
}

/**
 * Push a message to this user's frontend.
 *
 * `spindle.sendToFrontend(payload)` with no user id **broadcasts to every
 * connected user** on an operator-scoped install. The event-driven paths
 * (a tracker pass fired by `GENERATION_ENDED`) have no user id to hand, so
 * without this fallback every panel repaint went to everyone. Falling back to
 * the acting user keeps it targeted, and dropping the message when no user is
 * known is better than shouting.
 */
function send(message: ToFrontend, userId?: string): void {
  const target = userId ?? userScope()
  if (!target) return
  spindle.sendToFrontend(message, target)
}

/**
 * Follow the user's active chat so `ctx.chat` and `chat_metadata` always point
 * at the right conversation.
 */
/**
 * Abort every pass that commits into "the active chat" after a long await.
 *
 * Upstream's switch handler — in `index.js`, which this port replaces — stops
 * these five; the port stopped only the State Tracker. Each stop is separate
 * and failure-tolerant, as upstream's are: one module failing to load must not
 * leave the others running into the arriving chat.
 */
/**
 * Forked chats whose campaign is still being carried across.
 *
 * Upstream's `isBranchSeedInProgress`. Lumiverse emits `CHAT_FORKED` when the
 * fork is made and the switch into it arrives separately, while the carry is
 * still cloning lorebooks. Without this the switch would start the fork as a
 * blank new campaign, and the carry would then refuse it as already having one.
 */
const branchesBeingSeeded = new Set<string>()

/**
 * Chats the host has deleted this session.
 *
 * When the open chat is the one deleted, the switch away from it would
 * otherwise flush and save it as the departing chat — writing back exactly the
 * state the cleanup is removing.
 */
const deletedChats = new Set<string>()

/**
 * Chat switches, one at a time, in the order they were asked for.
 *
 * They used to run concurrently, and a switch is a dozen awaits long — so two
 * close together interleaved, and whichever attached last won. Switching to C
 * and then to B left the tracker on C while the user was in B. Upstream never
 * had this: SillyTavern delivers its switch event and the handler runs before
 * the next one. The chain gives the port the same order.
 *
 * `requestedChat` is where the queue is heading — the latest chat asked for,
 * known synchronously, which is what "the open chat" means to anything deciding
 * what to do next while switches are still queued.
 */
let chatQueue: Promise<unknown> = Promise.resolve()
let requestedChat: string | null | undefined

/**
 * Turns that finished in a chat the user had already left.
 *
 * Lumiverse generates on the server, detached from the page, so a reply keeps
 * streaming after the user opens another chat, and its GENERATION_ENDED names
 * the chat it was for. The port used to switch the tracker there to run the
 * turn's update — leaving the panel the user was looking at showing another
 * campaign, and taking whatever they did next into it. SillyTavern stops a
 * generation on a chat change, so upstream never meets the case.
 *
 * The update is postponed instead, keyed by chat, and runs on the way back in:
 * see `runPendingTurn`. One per chat — a chat generates one reply at a time.
 */
const pendingTurns = new Map<string, { generationType?: string; messageId?: string }>()

/**
 * A message in the open chat was swiped or edited: upstream's handler rolls
 * back the relationship changes, and the map updater, map evolution and
 * Lorebook Agent passes, that belonged to the reply that was replaced — and in
 * regex mode reads relationships from the new text. It skips itself while a
 * generation is running.
 */
async function runMessageChange(): Promise<void> {
  try {
    const hooks = await import('./engine/narrative-hooks.js') as {
      handleRelationshipSwipeChange?: () => Promise<void>
    }
    await hooks.handleRelationshipSwipeChange?.()
    await renderPanel()
  } catch (error) {
    spindle.log.warn(`[DnD] swipe/edit handling failed: ${(error as Error).message}`)
  }
}

/**
 * On opening a chat, finish a Map Architect fence its last reply asked for and
 * nothing processed — upstream's `catchUpMapArchitectFence`. Returns at once
 * unless persistent maps are on and there is an unprocessed fence.
 */
async function catchUpMapArchitectFence(): Promise<void> {
  try {
    const hooks = await import('./engine/narrative-hooks.js') as {
      onMapArchitectAssistantMessage?: (messageId?: number, type?: string) => Promise<unknown>
    }
    const { withChatPinned } = await import('./compat/context')
    await withChatPinned(async () => {
      await hooks.onMapArchitectAssistantMessage?.(undefined, 'normal')
    })
  } catch (error) {
    spindle.log.warn(`[DnD] Map Architect catch-up failed: ${(error as Error).message}`)
  }
}

/**
 * The post-turn pipeline: the tracker, the Lorebook Agent, the map updater,
 * the evolution pass and World Progression, for the open chat's latest turn.
 *
 * `generationType` is passed only for a postponed turn. The engine reads the
 * type from what `onGenerationStarted` recorded, and by the time a postponed
 * turn runs, another chat's generation may have recorded its own since.
 */
async function runPostTurn(generationType?: string): Promise<void> {
  const hooks = await import('./engine/narrative-hooks.js') as {
    onGenerationStarted?: (type?: string) => void
    onGenerationEnded?: () => Promise<void>
  }
  if (generationType !== undefined) hooks.onGenerationStarted?.(generationType)
  /*
   * The whole post-turn pipeline belongs to the turn that just ended.
   *
   * It is several model calls, and every one of the writes afterwards asks
   * `ctx.chatId` again at the moment it writes. A chat switch anywhere in there
   * used to redirect the lot into the chat the user had moved to. Pinning keeps
   * the results with the turn that produced them; the passes that must not run
   * at all against a moved-on chat (the tracker) check the chat mirror
   * themselves and still stop.
   */
  const { withChatPinned } = await import('./compat/context')
  await withChatPinned(async () => {
    if (hooks.onGenerationEnded) {
      await hooks.onGenerationEnded()
    } else {
      // Fall back to the tracker alone rather than doing nothing.
      spindle.log.warn('[DnD] onGenerationEnded missing; running the tracker pass directly')
      await runTrackerPass()
    }
  })
  await renderPanel()
  // The Lorebook Agent may have filed something this turn. An open Records
  // tab read once, when it was built or reopened, and never again — so what
  // the agent wrote stayed invisible until the user went looking.
  try {
    const { readCampaignRecords } = await import('./tracker/records')
    send({ type: 'records:state', ...(await readCampaignRecords()) })
  } catch (error) {
    spindle.log.warn(`[DnD] refreshing the records failed: ${(error as Error).message}`)
  }
}

/** A turn finished in a chat the user has left: keep it for their return. */
function postponeTurn(
  payload: { chatId?: string; messageId?: string; generationType?: string; error?: string },
  userId?: string,
): void {
  const chatId = payload.chatId!
  // Nothing new to track: a failed generation added no reply, and quiet or
  // impersonate generations never touch the story.
  if (payload.error || payload.generationType === 'quiet' || payload.generationType === 'impersonate') return
  pendingTurns.set(chatId, { generationType: payload.generationType, messageId: payload.messageId })
  void (async () => {
    const settings = await currentSettings()
    if (settings.enabled === false) return
    let name = ''
    try {
      name = String((await spindle.chats.get(chatId, userScope()))?.name ?? '')
    } catch {
      // The name is a courtesy.
    }
    send({
      type: 'toast', level: 'info',
      message: `A reply finished in ${name ? `"${name}"` : 'another chat'}. `
        + 'Its tracker update will run when you go back there.',
    }, userId)
  })().catch(() => undefined)
}

/**
 * Run a postponed turn on arriving in its chat — if the reply it was for is
 * still the chat's latest. A regenerated or deleted reply means the turn it
 * described no longer exists, and tracking it would describe something else.
 */
async function runPendingTurn(chatId: string): Promise<void> {
  const pending = pendingTurns.get(chatId)
  if (!pending) return
  pendingTurns.delete(chatId)
  if (pending.messageId) {
    const latest = [...chatMirror.messages].reverse().find(entry => !entry.is_user)
    if (latest?._lvId !== pending.messageId) {
      spindle.log.info(`[DnD] postponed turn for ${chatId} skipped: its reply is no longer the latest`)
      return
    }
  }
  // Left again already: keep it for the next visit.
  if (requestedChat !== chatId || chatMirror.getChatId() !== chatId) {
    pendingTurns.set(chatId, pending)
    return
  }
  try {
    await runPostTurn(pending.generationType)
  } catch (error) {
    spindle.log.error(`[DnD] postponed post-generation pipeline failed: ${(error as Error).message}`)
  }
}

/** Send the open chat's Loom summary to the panel's "Story so far". */
async function syncStory(userId?: string): Promise<void> {
  try {
    const { getLoomSummary } = await import('./tracker/loom')
    const chatId = chatMirror.getChatId()
    send({ type: 'story:state', chatId, summary: await getLoomSummary(chatId) }, userId)
  } catch (error) {
    spindle.log.warn(`[DnD] reading the story so far failed: ${(error as Error).message}`)
  }
}

/**
 * Run upstream's automatic art — a check for newcomers, or with `force`, a
 * pass over everyone the switched-on options cover. Off by default, and a
 * no-op while it is. See `tracker/auto-art.ts`.
 */
async function runAutoArt(userId?: string, force = false): Promise<void> {
  const art = await import('./tracker/auto-art')
  const deps = {
    refresh: () => { void renderPanel(userId) },
    warn: (message: string) => send({ type: 'toast', level: 'warning', message }, userId),
  }
  await (force ? art.forceAutoArt(deps) : art.checkAutoArt(deps))
}

/** A cleanup outcome in one sentence. */
function describeCleanup(
  result: { skipped?: string, removed: string[], lorebooksDeleted: string[], lorebooksFailed: string[] },
  nothing: string,
): string {
  if (result.skipped === 'cancelled') return 'Clean-up cancelled — nothing was removed.'
  if (result.skipped && !result.removed.length) return `Nothing removed: ${result.skipped}.`
  if (!result.removed.length && !result.lorebooksDeleted.length) return nothing
  const parts = [`Removed saved data for ${result.removed.length} deleted chat(s)`]
  if (result.lorebooksDeleted.length) parts.push(`and ${result.lorebooksDeleted.length} lorebook(s)`)
  let text = `${parts.join(' ')}.`
  if (result.lorebooksFailed.length) text += ` ${result.lorebooksFailed.length} lorebook(s) could not be deleted.`
  return text
}

/**
 * Decide what a chat with no saved tracker state starts from.
 *
 * A clean campaign, in general — but not unconditionally, because both of the
 * exceptions upstream makes are cases where blanking destroys real data:
 *
 *   - **Chat Link off.** The user has chosen one tracker state shared by every
 *     chat. Upstream returns before its reset; resetting here would wipe that
 *     shared campaign on every switch.
 *   - **The first chat attached at startup.** Its campaign may live only in the
 *     saved settings — an older save, or a partition write that never landed.
 *     `shouldPreserveLiveChatStateOnBoot` adopts the live state when it has
 *     substance and is not owned by some other chat, exactly as upstream's
 *     deferred-boot path does; otherwise this falls through to a clean start.
 */
async function projectUnseenChat(chatId: string, firstAttach: boolean): Promise<void> {
  const settings = await currentSettings() as Record<string, any>
  if (!settings.chatLinkEnabled) return
  if (firstAttach) {
    const persistence = await import('./engine/src/state/chat-persistence.js') as {
      shouldPreserveLiveChatStateOnBoot?: (s: unknown, id: string) => boolean
      saveChatState?: (id: string) => unknown
    }
    if (persistence.shouldPreserveLiveChatStateOnBoot?.(settings, chatId)) {
      persistence.saveChatState?.(chatId)
      spindle.log.info(`[DnD] chat ${chatId} adopted the campaign already loaded at startup`)
      return
    }
  }
  await resetUnseenChatState(chatId)
  spindle.log.info(`[DnD] chat ${chatId} is new — started a clean campaign`)
}

async function stopInFlightPasses(): Promise<void> {
  const { stopStatePass } = await import('./tracker/state-pass')
  stopStatePass()
  // Literal specifiers, one per module, on purpose. A loop over a list of paths
  // reads better and is invisible to the bundler: `import(path)` passes every
  // test, which run from `src/`, and fails every time from `dist/backend.js` —
  // where the catch below would turn that into a warning nobody reads.
  const stops: Array<[string, () => Promise<unknown>]> = [
    ['router', async () => {
      const mod = await import('./engine/router.js') as any
      mod.stopRouterPass?.()
      mod.stopWorldProgressionPass?.()
    }],
    ['map updater', async () =>
      (await import('./engine/map-updater.js') as any).stopMapUpdaterPass?.()],
    ['map evolution', async () =>
      (await import('./engine/map-evolution.js') as any).stopMapEvolutionPass?.()],
    ['real-time art', async () =>
      (await import('./engine/portraits.js') as any).stopRealtimeLocationGeneration?.({ disable: false })],
  ]
  for (const [name, stop] of stops) {
    try {
      await stop()
    } catch (error) {
      spindle.log.warn(`[DnD] stopping the ${name} pass on chat switch failed: ${(error as Error).message}`)
    }
  }
}

async function syncActiveChat(chatId: string | null): Promise<void> {
  // A request to leave the chat means in-flight work no longer owns it — now,
  // not once the queue reaches this switch. See the epoch, below.
  if (chatId !== requestedChat) invalidateChatCommitGuards()
  requestedChat = chatId
  const run = chatQueue.then(() => switchChat(chatId))
  chatQueue = run.catch(() => undefined)
  const switched = await run
  // Outside the queue: this can ask the user a question, and every switch
  // after it would wait for the answer. Skipped if the user has moved on.
  if (switched && requestedChat === chatId && chatMirror.getChatId() === chatId) {
    // A chat's first art check only records who is already there, so this is
    // what keeps a newcomer in its first reply from being taken for old cast.
    void runAutoArt()
    if (chatId) void runPendingTurn(chatId)
    void catchUpMapArchitectFence()
    const { checkRecoveryOnOpen } = await import('./tracker/recovery')
    await checkRecoveryOnOpen(chatId)
  }
}

/** The open chat, counting switches already asked for but still queued. */
function openChat(): string | null {
  return requestedChat === undefined ? chatMirror.getChatId() : requestedChat
}

/**
 * Follow the chat the panel's own tab is showing.
 *
 * CHAT_SWITCHED is the *account's* `activeChatId` setting, written by
 * whichever tab or device wrote it last — and every chat view writes `null`
 * when it closes. A phone left on the home screen, or a second tab closing its
 * chat, told the tracker no chat was open while the PC in front of the user
 * still showed one, and Update state answered "chatId: none". Each tab knows
 * what it shows (`ctx.getActiveChat()`), and every frontend message now says.
 *
 * A tab showing no chat changes nothing: being elsewhere in the app is not a
 * reason to drop the campaign. A popup's answer never waits on a switch — the
 * question it answers may be holding one up.
 */
async function followViewedChat(payload: ToBackend): Promise<void> {
  if (payload?.type === 'popup:result') return
  const viewing = (payload as { viewChatId?: unknown }).viewChatId
  if (typeof viewing !== 'string' || !viewing) return
  if (viewing === openChat() || deletedChats.has(viewing)) return
  await syncActiveChat(viewing)
}

/** Run once the queued switches have finished. */
function afterQueuedSwitches(): Promise<unknown> {
  return chatQueue
}

/** One switch. Resolves to whether the chat actually changed. */
async function switchChat(chatId: string | null): Promise<boolean> {
  const previous = chatMirror.getChatId()
  const switching = chatId !== previous
  // Chat Link decides whether chats each own a campaign or share one. Upstream
  // gates the switch's save and load on it at the call site, in `index.js`; the
  // engine's loader and saver do not check it themselves, so the port must, or
  // "off" changes nothing. Read once, before anything is switched.
  const linked = !!(await currentSettings()).chatLinkEnabled

  if (switching) {
    /*
     * Everything in flight from before this point no longer owns its chat —
     * and that has to be true *now*, before the first await.
     *
     * The epoch is what makes an A → B → A round trip detectable: comparing
     * chat ids alone says "still chat A" and misses that A's state was swapped
     * out and back underneath the operation. Upstream bumps it first thing in
     * its switch handler, synchronously. The port first bumped it at the end of
     * this block, after two awaited flushes — and a Map Architect pass mid-way
     * through its model calls checked its guard inside that window, found it
     * still valid, and saved into a chat the user had already left before the
     * guard caught up with it. Hence the static import: a dynamic one is an
     * await of its own.
     */
    invalidateChatCommitGuards()
    // Then stop what upstream stops, before anything flips: these passes commit
    // via the live prefix after long awaits. Guarded paths would also notice on
    // their own at the next check; this ends the work rather than letting it
    // run to the check. `disable: false` keeps a chat switch from setting the
    // user's persistent Real-Time art off switch, as upstream is careful to.
    await stopInFlightPasses()
    // The companion's conversation goes first, while the departing chat is
    // still the live one — the engine requires that order and the port used to
    // break it. See `flushCompanionFor`.
    // A deleted chat has nothing to flush: saving it would write back the state
    // its cleanup removes. The cleanup already waits for queued switches, so
    // this is the second line, not the first, and it skips pointless work.
    const departingExists = !!previous && !deletedChats.has(previous)
    const { flushCompanionFor } = await import('./tracker/companion')
    if (departingExists) await flushCompanionFor(previous)
    // Portraits belong to the chat whether or not Chat Link is on.
    if (departingExists) await snapshotPortraitsFor(previous)
    // `settings.currentMemo` is a projection of one chat's state. Flush the
    // outgoing chat before the incoming one overwrites it, or an uncommitted
    // edit is lost and the projection is left belonging to the wrong chat.
    // With Chat Link off there is one shared campaign and nothing to flush it
    // into — upstream guards this save the same way.
    if (linked && departingExists) await saveChatStateFor(previous)
    // Two more things upstream's switch resets and the port never did, both
    // module state that otherwise follows the user into the next campaign:
    // the run-every counters and the Lorebook Agent's pending keyword pool —
    // keywords one story triggered, still queued when another story's agent
    // runs — and a combat connection override left on by a fight elsewhere.
    try {
      const hooks = await import('./engine/narrative-hooks.js') as {
        resetRouterTick?: (clearKeywordPool?: boolean) => void
      }
      hooks.resetRouterTick?.(true)
    } catch (error) {
      spindle.log.warn(`[DnD] resetting the agent schedule failed: ${(error as Error).message}`)
    }
    try {
      const llm = await import('./engine/llm-client.js') as {
        resetCombatProfileOverride?: (settings?: unknown) => Promise<void>
      }
      await llm.resetCombatProfileOverride?.()
    } catch (error) {
      spindle.log.warn(`[DnD] resetting the combat connection failed: ${(error as Error).message}`)
    }
  }

  setActiveChat(chatId)
  invalidateWorldInfoCache()
  await chatMirror.attach(chatId)
  await loadChatMetadata(chatId)
  // Which card this campaign is played against. Rolling a character reads it,
  // as do the portrait prompts — see `loadActiveCharacter`.
  await loadActiveCharacter(chatId)
  // And who is playing: `{{user}}` and `{{persona}}` resolve from this.
  await loadActivePersona()

  if (switching && !linked && chatId) {
    // One shared campaign: keep it, and reset only what upstream resets.
    await applyUnlinkedSwitch(chatId)
  } else if (switching) {
    const restored = await loadChatState(chatId)
    if (!restored && chatId) {
      const settings = await currentSettings()
      if (branchesBeingSeeded.has(chatId)) {
        // A fork is being carried into this chat right now. Blanking it would
        // let a save create an empty partition first, and the carry refuses a
        // chat that already has one. `CHAT_FORKED` loads it when done.
        spindle.log.info(`[DnD] chat ${chatId} is a branch still being seeded`)
      } else if (!(settings.chatStates as Record<string, unknown> | undefined)?.[chatId]) {
        await projectUnseenChat(chatId, previous === null)
      }
    }
  }
  if (switching) {
    // The arriving chat's own conversation, now that its state is restored.
    // This is only the load half: the departing chat was flushed above, before
    // `loadChatState` swapped the live session out from under it. A chat with
    // no snapshot gets an empty transcript rather than the previous campaign's.
    const { loadCompanionFor } = await import('./tracker/companion')
    await loadCompanionFor(chatId)
    await syncCompanion()
    // Then `syncActiveChat` offers a restore if the backup looks fuller than
    // what loaded. The engine decides whether it is worth asking.
  }
  return switching
}

/**
 * Read the engine's settings tree.
 *
 * This defers to the engine's own `getSettings()` rather than reaching into
 * `extensionSettings` by key. The engine owns the key name, the defaults, and a
 * long chain of version migrations; duplicating any of that here is how the two
 * halves drift apart.
 */
async function currentSettings(): Promise<Record<string, unknown>> {
  if (!settingsLoaded()) await ensureUserState()
  try {
    const stateManager = await import('./engine/state-manager.js') as {
      getSettings?: () => Record<string, unknown>
    }
    const settings = stateManager.getSettings?.()
    if (settings && typeof settings === 'object') return settings
  } catch (error) {
    spindle.log.error(`[DnD] engine getSettings() failed: ${(error as Error).message}`)
  }
  return {}
}

/**
 * Adapt Lumiverse's post-assembly interceptor to SillyTavern's pre-assembly one.
 *
 * The two hooks are not the same shape. SillyTavern hands the interceptor the
 * *chat array* before prompt assembly; Lumiverse hands it the *assembled prompt*
 * afterwards. The engine's injections (state memo, RNG queue, CYOA block) are
 * appends and strips over a message list, which survives the round trip — but
 * anything that depended on running before assembly will not see world info or
 * preset blocks here. That difference is the main behavioural caveat of the
 * port; see PORTING.md.
 */
/**
 * `LlmMessageDTO.content` may be a multi-part array (tool calls, thinking
 * blocks, attachments). The engine only ever reasons about text, so parts are
 * flattened on the way in. Non-text parts are dropped rather than stringified —
 * feeding a serialised tool_use block to a regex-based memo parser is worse
 * than feeding it nothing.
 */
function contentToText(content: LlmMessageDTO['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && typeof part === 'object' && 'text' in part
      ? String((part as { text?: unknown }).text ?? '')
      : ''))
    .filter(Boolean)
    .join('\n')
}

function adaptInterceptor(handler: TrackerInterceptor) {
  return async (messages: LlmMessageDTO[], context: InterceptorContextDTO): Promise<LlmMessageDTO[]> => {
    setActiveUser(context?.userId)
    await ensureUserState()
    const chatId = context?.chatId ?? chatMirror.getChatId()
    if (chatId && chatId !== chatMirror.getChatId()) await syncActiveChat(chatId)
    // Upstream's MESSAGE_SENT step, at the point the host waits for. See
    // `tracker/map-intent.ts`.
    const { mapIntentBeforeNarration } = await import('./tracker/map-intent')
    await mapIntentBeforeNarration(context)

    const shim: Partial<StMessage>[] = messages.map(message => ({
      name: message.name ?? '',
      is_user: message.role === 'user',
      is_system: message.role === 'system',
      mes: contentToText(message.content),
      extra: {},
    }))

    let aborted = false
    const abort = (): void => { aborted = true }

    try {
      await handler(shim, 0, abort, String(context?.generationType ?? 'normal'))
    } catch (error) {
      spindle.log.error(`[DnD] interceptor threw, prompt passed through: ${(error as Error).message}`)
      return messages
    }
    if (aborted) return messages

    let out = shim.map(entry => {
      // `roleForStMessage` reads the engine's `extra.type === 'narrator'`
      // marker, which is what keeps depth-injected framework notes out of the
      // conversation as fake narrator turns. See its docstring for the table.
      const role = roleForStMessage(entry)
      return {
        role,
        content: entry.mes ?? '',
        // `name` identifies a speaker. A promoted framework note has no
        // speaker, and some providers reject the field on `system`.
        ...(entry.name && role !== 'system' ? { name: entry.name } : {}),
      }
    }) as LlmMessageDTO[]

    // Every past CYOA menu is still in the chat, and without this every one of
    // them is still in the prompt. Runs after the handler so the choice block
    // the engine just injected is the one that survives.
    out = await stripSupersededChoices(out)

    // The narrator's ruleset. Upstream writes this into SillyTavern's Main
    // prompt; there is no preset here, so it rides ahead of the conversation.
    const ruleset = await narratorSysprompt()
    if (ruleset) out.unshift({ role: 'system', content: ruleset })

    // Lumiverse's Loom summary, when older messages have been cut and the
    // preset does not already include it. See `tracker/loom.ts`.
    try {
      const { withStorySoFar } = await import('./tracker/loom')
      out = await withStorySoFar(messages, out, chatMirror.getChatId(), chatMirror.messages, await currentSettings())
    } catch (error) {
      spindle.log.warn(`[DnD] adding the Loom summary failed: ${(error as Error).message}`)
    }

    return out
  }
}

/**
 * The assembled narrator ruleset, or `''` when it is switched off.
 *
 * Rebuilt per generation rather than cached: the Control Room toggles, the
 * time-format switches and the RNG switch all change the text, and a stale
 * ruleset is the kind of bug that looks like the model misbehaving.
 */
async function narratorSysprompt(): Promise<string> {
  try {
    const settings = await currentSettings()
    if (settings.enabled === false || settings.injectNarratorSysprompt === false) return ''
    const { buildSysprompt } = await import('./tracker/sysprompt')
    return await buildSysprompt()
  } catch (error) {
    // A broken ruleset must not take the user's turn with it.
    spindle.log.error(`[DnD] narrator sysprompt failed: ${(error as Error).message}`)
    return ''
  }
}

/**
 * Render the tracker panel. `renderer.js` is DOM-free and returns an HTML
 * string, so it runs here and the markup crosses to the frontend, where the
 * host sanitises it before insertion.
 */
async function renderPanelNow(userId?: string): Promise<void> {
  void syncStory(userId)
  try {
    const settings = await currentSettings()
    const memo = String(settings.currentMemo ?? '')
    if (!memo.trim()) {
      send({ type: 'panel:render', html: '', memoPresent: false, chatId: chatMirror.getChatId() }, userId)
      return
    }
    // Signature is (memo, filterTag, sectionPages, uiOptions) — `sectionPages`
    // is the engine's shared pagination state, so it has to be the real object
    // from the runtime bridge rather than a fresh one per render.
    const [renderer, bridge] = await Promise.all([
      import('./engine/renderer.js') as Promise<{
        renderMemoAsCards?: (
          memo: string,
          filterTag: string | null,
          sectionPages: Record<string, unknown>,
          uiOptions?: Record<string, unknown>,
        ) => string
        loadCollapsed?: () => Set<string>
        saveCollapsed?: (set: Set<string>) => void
      }>,
      // TS infers `sectionPages` as `{}` from the untyped JS; go through
      // `unknown` rather than widening the engine's own declaration.
      import('./engine/src/app/runtime-bridge.js') as unknown as Promise<{
        sectionPages?: Record<string, unknown>
      }>,
    ])
    // `showCategorySettings: false` drops the per-category cog, whose editor is
    // not ported. `fullViewSections` is the engine's own paged/full toggle.
    const html = renderer.renderMemoAsCards?.(memo, null, bridge.sectionPages ?? {}, {
      showCategorySettings: false,
      fullViewSections: [...fullViewSections],
    }) ?? ''
    send({ type: 'panel:render', html, memoPresent: true, chatId: chatMirror.getChatId() }, userId)
    // Upstream checks for newcomers to draw at the end of every render.
    void runAutoArt(userId)
  } catch (error) {
    spindle.log.error(`[DnD] panel render failed: ${(error as Error).message}`)
    send({ type: 'panel:render', html: '', memoPresent: false, chatId: chatMirror.getChatId() }, userId)
  }
}

/**
 * The repaint the rest of the backend calls.
 *
 * A single turn can ask for this half a dozen times: the tracker pass commits,
 * the Lorebook Agent finishes, World Progression writes, the map updater runs.
 * Each one re-renders the whole memo and ships the markup across, and the
 * frontend replaces the panel every time — which also throws away the bar
 * animations mid-flight.
 *
 * `createCoalescedRefresh` (33 lines, ported verbatim) collapses a burst into
 * the run in flight plus at most one more with the newest arguments. The last
 * caller still wins, which is the property that matters: the panel ends up
 * showing the newest state, it just stops rendering the four intermediate ones
 * nobody sees.
 */
const renderPanel: (userId?: string) => Promise<void> = (() => {
  let coalesced: ((userId?: string) => Promise<void>) | null = null
  let loading: Promise<void> | null = null

  return async (userId?: string): Promise<void> => {
    if (!coalesced) {
      // Loaded once, and guarded against two repaints racing to import it.
      loading ??= import('./engine/src/ui/panel/refresh-coalescer.js')
        .then((module: unknown) => {
          const create = (module as {
            createCoalescedRefresh?: (
              run: (...args: unknown[]) => Promise<unknown>,
            ) => (...args: unknown[]) => Promise<void>
          }).createCoalescedRefresh
          if (create) {
            coalesced = create(
              (...args: unknown[]) => renderPanelNow(args[0] as string | undefined),
            ) as (userId?: string) => Promise<void>
          }
        })
        .catch(error => {
          // Coalescing is an economy; losing it must not lose the panel.
          spindle.log.warn(`[DnD] repaint coalescing unavailable: ${(error as Error).message}`)
        })
      await loading
    }
    return coalesced ? coalesced(userId) : renderPanelNow(userId)
  }
})()

/** Sections the user switched to full-list rendering. Session-scoped, as upstream. */
const fullViewSections = new Set<string>()

/**
 * The rolled sheet awaiting review.
 *
 * Only the memo comes back from the review box; the persona portrait stays
 * here, so an approval cannot smuggle in an arbitrary image URL. The engine is
 * single-user by construction, so one slot is enough.
 */
let pendingRoll: import('./tracker/player-card').RollDraft | null = null

/**
 * Collapse or expand a section.
 *
 * Collapse state belongs to the engine — `renderMemoAsCards` reads it through
 * `loadCollapsed()` at render time — so this toggles the engine's own set
 * rather than tracking it separately. That set is backed by `localStorage`,
 * which the backend shims onto per-user storage, so it persists.
 */
async function toggleSection(tag: string, userId?: string): Promise<void> {
  try {
    const renderer = await import('./engine/renderer.js') as {
      loadCollapsed?: () => Set<string>
      saveCollapsed?: (set: Set<string>) => void
    }
    const collapsed = renderer.loadCollapsed?.() ?? new Set<string>()
    if (collapsed.has(tag)) collapsed.delete(tag)
    else collapsed.add(tag)
    renderer.saveCollapsed?.(collapsed)
  } catch (error) {
    spindle.log.warn(`[DnD] section toggle failed: ${(error as Error).message}`)
  }
  await renderPanel(userId)
}

/** Push the current settings plus the connection list to the settings UI. */
async function syncSettings(userId?: string): Promise<void> {
  let connections: Array<{ id: string; name: string }> = []
  if (spindle.permissions.has('generation')) {
    try {
      const list = await spindle.connections.list(userScope())
      connections = list.map(c => ({ id: c.id, name: c.name }))
    } catch (error) {
      spindle.log.warn(`[DnD] connection list failed: ${(error as Error).message}`)
    }
  }
  const settings = await currentSettings()
  send({
    type: 'settings:sync',
    // The lookback mode is a pair of booleans in the engine; the form binds to
    // one derived value. See `lookbackModeFrom`.
    settings: { ...settings, [LOOKBACK_MODE_KEY]: lookbackModeFrom(settings) },
    connections,
  }, userId)
}

function routeFrontendMessages(): () => void {
  return spindle.onFrontendMessage((raw: unknown, userId: string) => {
    void handleFrontendMessage(raw as ToBackend, userId)
  })
}

async function handleFrontendMessage(payload: ToBackend, userId: string): Promise<void> {
  {
    setActiveUser(userId)
    setPopupUser(userId)
    await followViewedChat(payload)
    switch (payload?.type) {
      case 'panel:ready':
      case 'panel:refresh':
        await renderPanel(userId)
        break
      case 'popup:result':
        resolvePopup(payload.requestId, payload.result)
        break
      case 'settings:get':
        await syncSettings(userId)
        break
      case 'settings:action': {
        if (payload.action === 'cleanDeletedChats') {
          const { cleanOrphanedChats } = await import('./tracker/chat-cleanup')
          const result = await cleanOrphanedChats()
          if (result.removed.length) await saveSettings()
          send({ type: 'toast', level: result.skipped && result.skipped !== 'cancelled' ? 'warning' : 'success',
            message: describeCleanup(result, 'Nothing to clean up — every saved campaign has its chat.') }, userId)
        }
        break
      }
      case 'cyoa:choose':
        await sendChoice(payload.text, userId)
        break
      case 'panel:toggle-section':
        await toggleSection(payload.tag, userId)
        break
      case 'panel:toggle-fullview':
        if (fullViewSections.has(payload.tag)) fullViewSections.delete(payload.tag)
        else fullViewSections.add(payload.tag)
        await renderPanel(userId)
        break
      case 'memo:read': {
        const { readMemo, readMemoHistory } = await import('./tracker/direct-prompt')
        send({
          type: 'memo:content',
          text: await readMemo(),
          history: await readMemoHistory(),
        }, userId)
        break
      }
      case 'memo:write': {
        const { writeMemo } = await import('./tracker/direct-prompt')
        const outcome = await writeMemo(payload.text)
        send({
          type: 'panel:result',
          ran: true,
          changed: outcome.changed,
          reason: outcome.changed ? undefined : 'no change',
          at: Date.now(),
        }, userId)
        if (outcome.changed) await renderPanel(userId)
        break
      }
      case 'tracker:ask': {
        const { askTracker } = await import('./tracker/direct-prompt')
        send({ type: 'panel:status', running: true, label: 'Asking the tracker…' }, userId)
        try {
          const outcome = await askTracker(payload.instruction)
          send({
            type: 'panel:result',
            ran: outcome.ok,
            changed: outcome.changed,
            reason: outcome.reason,
            at: Date.now(),
          }, userId)
          if (outcome.changed) await renderPanel(userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'pc:generate': {
        const { generatePlayerCard } = await import('./tracker/player-card')
        send({ type: 'panel:status', running: true, label: 'Creating Player Card…' }, userId)
        try {
          const draft = await generatePlayerCard()
          send({ type: 'pc:preview', ...draft }, userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'roll:open': {
        const { listArchetypes, listPersonas, CHARACTER_GENRES } =
          await import('./tracker/player-card')
        const settings = await currentSettings()
        const genre = payload.genre
          ?? String(settings.onboardingGenre ?? 'fantasy')
        send({
          type: 'roll:options',
          genre,
          genres: [...CHARACTER_GENRES],
          archetypes: await listArchetypes(genre),
          personas: await listPersonas(userScope()),
        }, userId)
        break
      }
      case 'roll:go': {
        const { rollCharacter } = await import('./tracker/player-card')
        send({ type: 'panel:status', running: true, label: 'Rolling character…' }, userId)
        try {
          const draft = await rollCharacter({
            className: payload.className,
            classOther: payload.classOther,
            genre: payload.genre,
            level: payload.level,
            gearTier: payload.gearTier,
            name: payload.name,
            personaId: payload.personaId,
          }, userScope())
          // Held so the commit carries only the edited sheet; the portrait URL
          // never round-trips through the frontend.
          pendingRoll = draft.ok ? draft : null
          send({
            type: 'roll:draft',
            ok: draft.ok,
            name: draft.name,
            memo: draft.memo,
            portraitUrl: draft.portraitUrl || undefined,
            reason: draft.reason,
          }, userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'theme:read':
        await syncTheme(userId)
        break
      case 'theme:generate': {
        const { generateTheme } = await import('./tracker/theme')
        send({ type: 'panel:status', running: true, label: 'Mixing colours…' }, userId)
        try {
          send({
            type: 'theme:draft',
            ...(await generateTheme(payload.description, payload.refine)),
          }, userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'theme:apply': {
        const { applyTheme } = await import('./tracker/theme')
        await applyTheme(payload.vars)
        await saveSettings()
        await syncTheme(userId)
        break
      }
      case 'theme:undo': {
        const { undoTheme } = await import('./tracker/theme')
        await undoTheme()
        await saveSettings()
        await syncTheme(userId)
        break
      }
      case 'theme:save':
      case 'theme:load':
      case 'theme:delete': {
        const theme = await import('./tracker/theme')
        const run = payload.type === 'theme:save'
          ? theme.saveTheme
          : payload.type === 'theme:load' ? theme.loadTheme : theme.deleteTheme
        const outcome = await run(payload.name)
        if (!outcome.ok) {
          send({
            type: 'toast', level: 'warning',
            message: `Theme: ${outcome.reason ?? 'unknown error'}.`,
          }, userId)
        }
        await saveSettings()
        await syncTheme(userId)
        break
      }
      case 'portrait:gen-read': {
        const { imageGenAvailable, portraitTargets } = await import('./tracker/portrait-gen')
        const available = await imageGenAvailable()
        send({
          type: 'portrait:gen-state',
          available: available.ok,
          reason: available.reason,
          targets: await portraitTargets(),
        }, userId)
        break
      }
      case 'portrait:describe': {
        const { describeForPortrait } = await import('./tracker/portrait-gen')
        const outcome = await describeForPortrait(payload.entity)
        send({
          type: 'portrait:gen-result',
          entity: payload.entity,
          promptOnly: true,
          ...outcome,
        }, userId)
        break
      }
      case 'portrait:generate': {
        const { generatePortrait } = await import('./tracker/portrait-gen')
        send({ type: 'panel:status', running: true, label: 'Drawing…' }, userId)
        try {
          const outcome = await generatePortrait(
            payload.entity, payload.prompt, userScope(),
          )
          send({
            type: 'portrait:gen-result',
            entity: payload.entity,
            promptOnly: false,
            ...outcome,
          }, userId)
          if (outcome.ok) {
            await saveSettings()
            await renderPanel(userId)
          }
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'cartridge:read':
        await syncCartridges(userId)
        break
      case 'cartridge:inspect': {
        const { inspectCartridge } = await import('./tracker/cartridges')
        const outcome = await inspectCartridge(payload.id)
        send({ type: 'cartridge:detail', id: payload.id, ...outcome }, userId)
        break
      }
      case 'cartridge:save': {
        const { saveCurrentAsCartridge } = await import('./tracker/cartridges')
        const outcome = await saveCurrentAsCartridge(
          payload.name, payload.description, payload.icon,
        )
        send({
          type: 'toast',
          level: outcome.ok ? 'success' : 'warning',
          message: outcome.ok
            ? `Saved "${payload.name}".`
            : `Not saved — ${outcome.reason ?? 'unknown error'}.`,
        }, userId)
        if (outcome.ok) await saveSettings()
        await syncCartridges(userId)
        break
      }
      case 'cartridge:load': {
        const { loadCartridge } = await import('./tracker/cartridges')
        const outcome = await loadCartridge(payload.id, payload.groups)
        send({
          type: 'toast',
          level: outcome.ok ? 'success' : 'warning',
          message: outcome.ok
            ? `Loaded: ${(outcome.applied ?? []).join(', ')}.`
            : `Not loaded — ${outcome.reason ?? 'unknown error'}.`,
        }, userId)
        if (outcome.ok) {
          await saveSettings()
          // A cartridge can change the ruleset, the record types, the map
          // tools and the panel — repaint everything rather than guess.
          await syncSettings(userId)
          await syncSysprompt(userId)
          await syncModules(userId)
          await syncMapRuntime()
          await renderPanel(userId)
        }
        await syncCartridges(userId)
        break
      }
      case 'cartridge:delete': {
        const { deleteCartridge } = await import('./tracker/cartridges')
        await deleteCartridge(payload.id)
        await saveSettings()
        await syncCartridges(userId)
        break
      }
      case 'cartridge:export': {
        const { exportCartridge } = await import('./tracker/cartridges')
        send({ type: 'cartridge:exported', ...(await exportCartridge(payload.id)) }, userId)
        break
      }
      case 'cartridge:import': {
        const { importCartridge } = await import('./tracker/cartridges')
        const outcome = await importCartridge(payload.text)
        send({
          type: 'toast',
          level: outcome.ok ? 'success' : 'warning',
          message: outcome.ok
            ? `Imported "${outcome.name}". Load it when you want it.`
            : `Not imported — ${outcome.reason ?? 'unknown error'}.`,
        }, userId)
        if (outcome.ok) await saveSettings()
        await syncCartridges(userId)
        break
      }
      case 'campaign:clone': {
        const { cloneCampaign } = await import('./tracker/branching')
        send({ type: 'panel:status', running: true, label: 'Copying the campaign…' }, userId)
        try {
          const outcome = await cloneCampaign(payload.prefix)
          if (outcome.ok) await saveSettings()
          send({ type: 'campaign:cloned', ...outcome }, userId)
          send({
            type: 'toast',
            level: outcome.ok ? 'success' : 'warning',
            message: outcome.ok
              ? `Copied ${outcome.cloned} lorebook(s) to "${payload.prefix}".`
              : `Not copied — ${outcome.reason ?? 'unknown error'}.`,
          }, userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'npc:read':
        await syncLibrary(userId)
        break
      case 'npc:save': {
        const { saveCard } = await import('./tracker/npc-library')
        const outcome = await saveCard(payload)
        if (!outcome.ok) {
          send({
            type: 'toast', level: 'warning',
            message: `Not saved — ${outcome.reason ?? 'unknown error'}.`,
          }, userId)
        }
        await saveSettings()
        await syncLibrary(userId)
        break
      }
      case 'npc:capture': {
        const { captureFromCampaign } = await import('./tracker/npc-library')
        const outcome = await captureFromCampaign(payload.name)
        send({
          type: 'toast',
          level: outcome.ok ? 'success' : 'warning',
          message: outcome.ok
            ? `Kept ${payload.name}.`
            : `Could not keep them — ${outcome.reason ?? 'unknown error'}.`,
        }, userId)
        await saveSettings()
        await syncLibrary(userId)
        break
      }
      case 'npc:delete': {
        const { deleteCard } = await import('./tracker/npc-library')
        await deleteCard(payload.id)
        await saveSettings()
        await syncLibrary(userId)
        break
      }
      case 'npc:export': {
        const { exportCard } = await import('./tracker/npc-library')
        send({ type: 'npc:exported', ...(await exportCard(payload.id)) }, userId)
        break
      }
      case 'npc:import': {
        const { importCards } = await import('./tracker/npc-library')
        const outcome = await importCards(payload.text)
        send({
          type: 'toast',
          level: outcome.ok ? 'success' : 'warning',
          message: outcome.ok
            ? `Imported ${outcome.added} card${outcome.added === 1 ? '' : 's'}.`
            : `Nothing imported — ${outcome.reason ?? 'unknown error'}.`,
        }, userId)
        await saveSettings()
        await syncLibrary(userId)
        break
      }
      case 'npc:use': {
        const { useCard } = await import('./tracker/npc-library')
        send({ type: 'panel:status', running: true, label: 'Bringing them in…' }, userId)
        try {
          const outcome = await useCard(payload.id, payload.as)
          send({
            type: 'toast',
            level: outcome.ok ? 'success' : 'warning',
            message: outcome.ok
              ? (payload.as === 'pc' ? 'Applied as your character.' : 'Added to the party.')
              : `Not applied — ${outcome.reason ?? 'unknown error'}.`,
          }, userId)
          if (outcome.ok) await renderPanel(userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'scene:read':
        await syncScene(userId)
        break
      case 'scene:draw': {
        const { generateSceneArt } = await import('./tracker/immersion')
        send({ type: 'panel:status', running: true, label: 'Painting the scene…' }, userId)
        try {
          const outcome = await generateSceneArt(userScope())
          send({
            type: 'toast',
            level: outcome.ok ? 'success' : 'warning',
            message: outcome.ok
              ? 'Scene art drawn.'
              : `Not drawn — ${outcome.reason ?? 'unknown error'}.`,
          }, userId)
          if (outcome.ok) await saveSettings()
          await syncScene(userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'scene:clear': {
        const { clearSceneArt } = await import('./tracker/immersion')
        await clearSceneArt()
        await saveSettings()
        await syncScene(userId)
        break
      }
      case 'maps:list': {
        const { listMaps } = await import('./tracker/map-view')
        send({ type: 'maps:list', ...(await listMaps()) }, userId)
        break
      }
      case 'maps:render': {
        const { renderMap } = await import('./tracker/map-view')
        const rendered = await renderMap(payload.id, payload.revealAll)
        send({ type: 'maps:render', id: payload.id, ...rendered }, userId)
        break
      }
      case 'maps:edit': {
        const { readMapForEdit } = await import('./tracker/map-edit')
        send({ type: 'maps:draft', id: payload.id, ...(await readMapForEdit(payload.id)) }, userId)
        break
      }
      case 'maps:save': {
        const { saveMapEdit } = await import('./tracker/map-edit')
        send({ type: 'maps:saved', id: payload.id, ...(await saveMapEdit(payload.id, payload.text)) }, userId)
        break
      }
      case 'maps:restore': {
        const { restoreMapSnapshot } = await import('./tracker/map-edit')
        const result = await restoreMapSnapshot(payload.id, payload.index)
        send({ type: 'maps:saved', id: payload.id, ...result }, userId)
        // The restored document is what the editor should now be showing.
        if (result.ok) {
          const { readMapForEdit } = await import('./tracker/map-edit')
          send({ type: 'maps:draft', id: payload.id, ...(await readMapForEdit(payload.id)) }, userId)
        }
        break
      }
      case 'maps:export': {
        const { exportMap } = await import('./tracker/map-edit')
        send({ type: 'maps:export', ...(await exportMap(payload.id)) }, userId)
        break
      }
      case 'maps:import': {
        const { importMap, readMapForEdit } = await import('./tracker/map-edit')
        const result = await importMap(payload.id, payload.json)
        send({ type: 'maps:saved', id: payload.id, ...result }, userId)
        if (result.ok) {
          send({ type: 'maps:draft', id: payload.id, ...(await readMapForEdit(payload.id)) }, userId)
        }
        break
      }
      case 'prompts:check': {
        const { checkPromptDefaults } = await import('./tracker/prompt-defaults')
        send({ type: 'prompts:changed', ...(await checkPromptDefaults()) }, userId)
        break
      }
      case 'prompts:apply': {
        const { applyPromptDefaults } = await import('./tracker/prompt-defaults')
        const result = await applyPromptDefaults(payload.categories)
        send({ type: 'prompts:applied', ...result }, userId)
        // Taking new defaults rewrites prompts the settings surface is showing.
        if (result.ok && result.applied.length) await syncSettings(userId)
        break
      }
      case 'groups:read':
      case 'groups:enable':
      case 'groups:gaps':
      case 'groups:add':
      case 'groups:rename':
      case 'groups:toggle':
      case 'groups:delete':
      case 'groups:assign':
      case 'groups:move': {
        await handleDisplayGroups(payload, userId)
        break
      }
      case 'blocks:read':
      case 'blocks:move':
      case 'blocks:enable':
      case 'blocks:save':
      case 'blocks:delete':
      case 'blocks:prompt':
      case 'blocks:prompt-reset': {
        await handleBlocks(payload, userId)
        break
      }
      case 'sections:read':
      case 'sections:add':
      case 'sections:update':
      case 'sections:move':
      case 'sections:delete':
      case 'sections:reset': {
        await handleSections(payload, userId)
        break
      }
      case 'cortex:read': {
        const { readCortex } = await import('./tracker/cortex')
        send({ type: 'cortex:state', ...(await readCortex(userId)) }, userId)
        break
      }
      case 'cortex:sync': {
        const { readCortex, syncToCortex } = await import('./tracker/cortex')
        const result = await syncToCortex(userId)
        send({ type: 'cortex:synced', ...result }, userId)
        // The graph moved; the view beside it should say so.
        send({ type: 'cortex:state', ...(await readCortex(userId)) }, userId)
        break
      }
      case 'cortex:enable': {
        const { readCortex, setCortexSync } = await import('./tracker/cortex')
        await setCortexSync(payload.enabled)
        send({ type: 'cortex:state', ...(await readCortex(userId)) }, userId)
        break
      }
      case 'agent:read': {
        const { readAgentView } = await import('./tracker/agent-view')
        send({ type: 'agent:view', ...(await readAgentView()) }, userId)
        break
      }
      case 'agent:deactivate': {
        const { deactivateKey, readAgentView } = await import('./tracker/agent-view')
        await deactivateKey(payload.id)
        await saveSettings()
        send({ type: 'agent:view', ...(await readAgentView()) }, userId)
        break
      }
      case 'terminal:run': {
        const { runTerminal } = await import('./tracker/terminal')
        send({ type: 'panel:status', running: true, label: 'Running…' }, userId)
        try {
          const result = await runTerminal(
            payload.target as never, payload.instruction, payload.lookback,
          )
          send({ type: 'terminal:result', target: payload.target, ...result }, userId)
          // A pass can change the memo, the lorebooks, or a map.
          await renderPanel(userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'records:read': {
        const { readCampaignRecords } = await import('./tracker/records')
        send({ type: 'records:state', ...(await readCampaignRecords()) }, userId)
        break
      }
      case 'records:entry': {
        const { readRecordEntry } = await import('./tracker/records')
        const outcome = await readRecordEntry(payload.id)
        send({ type: 'records:entry', id: payload.id, ...outcome }, userId)
        break
      }
      case 'wizard:open': {
        const { wizardExamples } = await import('./tracker/wizard')
        send({ type: 'wizard:examples', examples: await wizardExamples() }, userId)
        break
      }
      case 'wizard:draft': {
        const { draftGameSystem } = await import('./tracker/wizard')
        send({ type: 'panel:status', running: true, label: 'Designing the system…' }, userId)
        try {
          const outcome = await draftGameSystem(payload.description, payload.effectOwner)
          send({ type: 'wizard:draft', ...outcome }, userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'wizard:save': {
        const { saveGameSystem } = await import('./tracker/wizard')
        if (!payload.draft) break
        const outcome = await saveGameSystem(payload.draft, payload.enable)
        send({
          type: 'toast',
          level: outcome.ok ? 'success' : 'warning',
          message: outcome.ok
            ? `Saved "${payload.draft.name}".`
            : `Not saved — ${outcome.reason ?? 'unknown error'}.`,
        }, userId)
        if (outcome.ok) {
          await saveSettings()
          await syncSysprompt(userId)
          await renderPanel(userId)
        }
        break
      }
      case 'wizard:delete': {
        const { deleteGameSystem } = await import('./tracker/wizard')
        const outcome = await deleteGameSystem(payload.id)
        if (outcome.ok) {
          await saveSettings()
          await syncSysprompt(userId)
          await renderPanel(userId)
        }
        break
      }
      case 'modules:read':
        await syncModules(userId)
        break
      case 'modules:patch': {
        const { patchModule } = await import('./tracker/modules')
        await patchModule(payload.id, {
          enabled: payload.enabled,
          format: payload.format,
          instruction: payload.instruction,
        })
        await saveSettings()
        await syncModules(userId)
        break
      }
      case 'modules:reset': {
        const { resetModule } = await import('./tracker/modules')
        await resetModule(payload.id)
        await saveSettings()
        await syncModules(userId)
        break
      }
      case 'sysprompt:read':
        await syncSysprompt(userId)
        break
      case 'sysprompt:toggle': {
        const { setSectionEnabled } = await import('./tracker/sysprompt')
        await setSectionEnabled(payload.tag, payload.enabled)
        await saveSettings()
        await syncSysprompt(userId)
        // The module toggles in the settings form mirror these rows.
        await syncSettings(userId)
        break
      }
      case 'sysprompt:system': {
        const { setGameSystemEnabled } = await import('./tracker/sysprompt')
        await setGameSystemEnabled(payload.id, payload.enabled)
        await saveSettings()
        await syncSysprompt(userId)
        break
      }
      case 'companion:read':
        await syncCompanion(userId)
        break
      case 'companion:ask': {
        const { askCompanion } = await import('./tracker/companion')
        await syncCompanion(userId, true)
        const outcome = await askCompanion(payload.text, userScope())
        if (!outcome.ok && outcome.reason && outcome.reason !== 'cancelled') {
          send({
            type: 'toast',
            level: 'warning',
            message: `Companion: ${outcome.reason}`,
          }, userId)
        }
        // Repaint either way: the failure is in the transcript too.
        await syncCompanion(userId)
        break
      }
      case 'companion:cancel': {
        const { cancelCompanionTurn } = await import('./tracker/companion')
        cancelCompanionTurn()
        break
      }
      case 'companion:clear': {
        const { clearCompanionHistory } = await import('./tracker/companion')
        await clearCompanionHistory()
        await syncCompanion(userId)
        break
      }
      case 'companion:prefs': {
        const { writeCompanionPrefs } = await import('./tracker/companion')
        await writeCompanionPrefs(payload.patch)
        await syncCompanion(userId)
        break
      }
      case 'portrait:open': {
        const { currentPortrait, listPortraitChoices } = await import('./tracker/portraits')
        send({
          type: 'portrait:options',
          entity: payload.entity,
          current: await currentPortrait(payload.entity),
          personas: await listPortraitChoices(userScope()),
        }, userId)
        break
      }
      case 'portrait:set': {
        const { setPortrait } = await import('./tracker/portraits')
        // An upload can take a moment, and the card gives no sign on its own.
        send({ type: 'panel:status', running: true, label: 'Setting portrait…' }, userId)
        try {
          const outcome = await setPortrait(payload.entity, {
            personaId: payload.personaId,
            url: payload.url,
            dataUrl: payload.dataUrl,
            filename: payload.filename,
          }, userScope())
          if (outcome.ok) {
            await renderPanel(userId)
          } else {
            send({
              type: 'toast',
              level: 'warning',
              message: `Portrait not set — ${outcome.reason ?? 'unknown error'}.`,
            }, userId)
          }
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'portrait:clear': {
        const { clearPortrait } = await import('./tracker/portraits')
        await clearPortrait(payload.entity)
        await renderPanel(userId)
        break
      }
      case 'roll:commit': {
        const { commitRoll } = await import('./tracker/player-card')
        const draft = pendingRoll
        if (!draft) {
          send({
            type: 'panel:result',
            ran: true,
            changed: false,
            reason: 'that roll is no longer pending — roll again',
            at: Date.now(),
          }, userId)
          break
        }
        const outcome = await commitRoll({
          memo: payload.memo,
          name: draft.name,
          portraitUrl: draft.portraitUrl,
          personaName: draft.personaName,
          // Which chat it was rolled for — the commit refuses to write into
          // any other one.
          chatId: draft.chatId,
        })
        // Only on success. Clearing first meant a failed commit threw the
        // rolled sheet away, and the review modal had already closed — the
        // character was gone with nothing to retry from.
        if (outcome.ok) pendingRoll = null
        send({
          type: 'panel:result',
          ran: true,
          changed: outcome.ok && outcome.changed,
          reason: outcome.ok ? undefined : outcome.reason,
          at: Date.now(),
        }, userId)
        if (outcome.ok) {
          send({
            type: 'toast',
            level: 'success',
            message: outcome.portrait
              ? `${draft.name ?? 'Your character'} is ready, portrait taken from the persona.`
              : `${draft.name ?? 'Your character'} is ready.`,
          }, userId)
          await renderPanel(userId)
        }
        break
      }
      case 'pc:add': {
        const { addPlayerCard } = await import('./tracker/player-card')
        const outcome = await addPlayerCard(payload.name, payload.bio, payload.wordCount)
        send({
          type: 'panel:result',
          ran: true,
          changed: outcome.ok,
          reason: outcome.ok
            ? undefined
            : outcome.reason ?? 'the Player Card was not stored',
          at: Date.now(),
        }, userId)
        if (outcome.ok) {
          send({
            type: 'toast',
            level: 'success',
            message: `"${payload.name}" added as Player in the Lorebook Agent.`,
          }, userId)
          await renderPanel(userId)
        }
        break
      }
      case 'tracker:run':
        await runTrackerPass(userId)
        break
      case 'tracker:full-audit':
        await runAudit(userId)
        break
      case 'quickstart:roll-name': {
        const { rollName } = await import('./tracker/quickstart')
        send({ type: 'quickstart:name', name: await rollName(payload.genre) }, userId)
        break
      }
      case 'quickstart:run': {
        const { runQuickStart } = await import('./tracker/quickstart')
        send({ type: 'panel:status', running: true, label: 'Quick Start…' }, userId)
        try {
          const outcome = await runQuickStart(
            {
              genre: payload.genre,
              name: payload.name,
              instructions: payload.instructions,
              randomLevel: payload.randomLevel,
              sendStarter: payload.sendStarter,
            },
            // The opening turn goes through the same path a CYOA choice takes,
            // so it is an ordinary user message with the full pipeline behind
            // it rather than a special case. The chat it belongs to travels
            // with it — see `sendChoice`.
            (text, intoChatId) => sendChoice(text, userId, intoChatId),
            label => send({ type: 'quickstart:step', label }, userId),
          )
          send({
            type: 'quickstart:done',
            ok: outcome.ok,
            name: outcome.name,
            detail: outcome.detail,
            reason: outcome.reason,
          }, userId)
          // The sheet was written by the character generator, not by a pass, so
          // nothing else is going to repaint it.
          if (outcome.ok) await renderPanel(userId)
        } finally {
          send({ type: 'panel:status', running: false }, userId)
        }
        break
      }
      case 'tracker:stop': {
        const { stopStatePass } = await import('./tracker/state-pass')
        stopStatePass()
        send({ type: 'panel:status', running: false }, userId)
        break
      }
      case 'settings:patch': {
        const settings = await currentSettings()
        const { AUTO_ART_KEYS } = await import('./tracker/auto-art')
        const artWasOn = new Set(AUTO_ART_KEYS.filter(key => settings[key] === true))
        // Keys are dotted paths (`syspromptModules.loot`), so a plain
        // Object.assign would create a literal key with a dot in it.
        for (const [key, value] of Object.entries(payload.patch)) {
          // The derived lookback mode expands to the pair the engine reads;
          // storing the derived key itself would leave a setting nothing uses.
          if (key === LOOKBACK_MODE_KEY) {
            for (const [pairKey, pairValue] of Object.entries(lookbackModeTo(value))) {
              writePath(settings, pairKey, pairValue)
            }
            continue
          }
          // Not written here: switching Chat Link on can need a decision about
          // which campaign the open chat keeps, and backing out of that must
          // leave the setting as it was. `applyChatLinkToggle` sets it.
          if (key === 'chatLinkEnabled') continue
          writePath(settings, key, value)
        }
        if ('chatLinkEnabled' in payload.patch
          && !!payload.patch.chatLinkEnabled !== !!settings.chatLinkEnabled) {
          const { applyChatLinkToggle } = await import('./compat/chat-state')
          const outcome = await applyChatLinkToggle(!!payload.patch.chatLinkEnabled)
          if (outcome.message) {
            send({
              type: 'toast', level: outcome.applied ? 'success' : 'info', message: outcome.message,
            }, userId)
          }
        }
        // Upstream's `applyLocationImageAutoMode`: drawing lorebook locations
        // turns location images on, and Real-Time mode (not ported) off.
        if (payload.patch.portraitAutoGenerateLocations === true) {
          settings.locationImages = true
          settings.portraitAutoGenerateSceneView = false
          settings.portraitRegenerateVisitedLocations = false
        }
        // Choosing a subsystem's connection stops it following the tracker's.
        // Without this the next `inheritConnections()` would overwrite the
        // choice, and the pick would look like it did nothing.
        const { inheritConnections, pinConnection } = await import('./tracker/connections')
        for (const key of Object.keys(payload.patch)) {
          const prefix = prefixForProfileKey(key)
          if (prefix) pinConnection(settings, prefix)
        }
        // Moving the tracker's own connection takes every still-following
        // subsystem with it. This runs whether or not maps are switched on.
        if ('connectionProfileId' in payload.patch || 'connectionSource' in payload.patch) {
          inheritConnections(settings)
        }
        // Changing the lore scope has to re-derive the filter now, not on the
        // next chat switch — otherwise the setting looks inert until you move.
        if ('loreScope' in payload.patch) {
          const { applyLoreScope } = await import('./compat/context')
          await applyLoreScope()
        }
        /*
         * Some settings are only *inputs* to prompt text stored separately —
         * changing them does nothing until it is rebuilt.
         *
         * This has to run before the save, not after it. It used to come after,
         * and `saveSettings()` writes immediately, so the toggle reached
         * storage and the text it implies did not: turn "Quest deadlines" off,
         * restart, and the panel said off while the stored prompt still taught
         * the DEADLINE rules. One save, after everything it has to capture.
         */
        const patched = Object.keys(payload.patch)
        const { applyTimeFormatChange, rebuildModuleInstructions, refreshQuestPrompt } =
          await import('./tracker/stock-prompts')
        if (patched.some(key => key.startsWith('syspromptModules.quests'))) {
          await refreshQuestPrompt(settings)
        }
        if (patched.some(key => key.startsWith('npcRelationship'))) {
          await rebuildModuleInstructions()
        }
        if ('use24hTime' in payload.patch || 'useDdMmYyFormat' in payload.patch) {
          await applyTimeFormatChange(settings, {
            use24hTime: 'use24hTime' in payload.patch,
            useDdMmYyFormat: 'useDdMmYyFormat' in payload.patch,
          })
        }
        await saveSettings()
        if ('connectionProfileId' in payload.patch) invalidateConnectionCache()
        // Toggling a dice tool has to reach the host registry, not just disk.
        if (Object.keys(payload.patch).some(key => key.startsWith('rngTool'))) {
          await syncDiceTools()
        }
        // Same for the Map Architect tool, and for the map subsystems' own
        // connections, which follow the tracker's unless pinned.
        const { affectsMapRuntime } = await import('./tracker/maps')
        if (affectsMapRuntime(Object.keys(payload.patch))) {
          await syncMapRuntime()
        }
        await syncSettings(userId)
        // Switching an Auto-Generate option on draws everyone it covers now,
        // as upstream does, rather than waiting for someone new to appear.
        if (AUTO_ART_KEYS.some(key => !artWasOn.has(key) && settings[key] === true)) {
          void runAutoArt(userId, true)
        }
        await renderPanel(userId)
        break
      }
      default:
        spindle.log.info(`[DnD] unhandled frontend message: ${JSON.stringify(payload)}`)
    }
  }
}

/**
 * Make sure the tracker has a connection to run its second pass against.
 *
 * Upstream this is a dropdown in the settings drawer. Until that UI is ported,
 * an unconfigured tracker silently does nothing, which reads as "the port is
 * broken" — so a single available connection is adopted automatically and
 * announced. More than one, and the choice stays the user's.
 */
async function ensureStateConnection(): Promise<void> {
  if (!spindle.permissions.has('generation')) return
  const settings = await currentSettings()
  if (settings.connectionSource === 'profile' && settings.connectionProfileId) return

  try {
    const connections = await spindle.connections.list(userScope())
    if (connections.length !== 1) {
      if (connections.length > 1) {
        spindle.log.info(
          `[DnD] ${connections.length} connections available; set one for the state model in the tracker panel.`,
        )
      }
      return
    }
    settings.connectionSource = 'profile'
    settings.connectionProfileId = connections[0].id
    await saveSettings()
    spindle.log.info(`[DnD] state model connection set to "${connections[0].name}"`)
  } catch (error) {
    spindle.log.warn(`[DnD] connection lookup failed: ${(error as Error).message}`)
  }
}

/**
 * Run a tracker pass and push the result to the panel.
 *
 * Deliberately not awaited by the generation pipeline: the pass makes its own
 * model call and must not hold up the user's turn.
 */
async function runTrackerPass(userId?: string): Promise<void> {
  const { runStatePass } = await import('./tracker/state-pass')
  send({ type: 'panel:status', running: true, label: 'Updating state…' }, userId)
  try {
    const result = await runStatePass()
    if (!result.ran && result.reason) {
      spindle.log.info(`[DnD] tracker pass skipped: ${result.reason}`)
    }
    // Report the outcome either way. A pass that declined to run is the most
    // confusing failure mode there is, because the panel looks identical to a
    // fresh install.
    send({
      type: 'panel:result',
      ran: result.ran,
      changed: result.changed,
      reason: result.reason,
      at: Date.now(),
    }, userId)
    if (result.changed) await renderPanel(userId)
  } finally {
    send({ type: 'panel:status', running: false }, userId)
  }
}

/**
 * Rebuild the memo from the whole chat.
 *
 * One model call per chunk, so the status line carries the chunk number: on a
 * long campaign this runs for minutes, and a panel that only said "working"
 * would be indistinguishable from one that had hung.
 *
 * The panel is repainted as chunks land rather than only at the end, because
 * each chunk commits — the sheet really is changing while this runs.
 */
async function runAudit(userId?: string): Promise<void> {
  const { runFullAudit } = await import('./tracker/state-pass')
  send({ type: 'panel:status', running: true, label: 'Full audit…' }, userId)
  try {
    const result = await runFullAudit((done, total) => {
      send({
        type: 'panel:status',
        running: true,
        label: `Full audit — chunk ${Math.min(done + 1, total)} of ${total}…`,
      }, userId)
      if (done > 0) void renderPanel(userId)
    })

    if (result.reason) spindle.log.info(`[DnD] full audit: ${result.reason}`)
    spindle.log.info(`[DnD] full audit committed ${result.committed}/${result.chunks} chunk(s)`)

    send({
      type: 'panel:result',
      ran: result.ran,
      changed: result.changed,
      // The chunk count is the part worth surfacing: it turns "nothing
      // happened" into "it read the whole campaign and found nothing to fix".
      reason: result.reason
        ?? (result.chunks ? `audited ${result.committed} of ${result.chunks} chunk(s)` : undefined),
      at: Date.now(),
    }, userId)
    await renderPanel(userId)
  } finally {
    send({ type: 'panel:status', running: false }, userId)
  }
}

/**
 * Every tracker-cards message.
 *
 * Grouped like Display Groups and for the same reason: each changes the same
 * small structure and the editor needs the whole thing back. Anything but a
 * read repaints, because order and enablement are precisely what the panel
 * draws.
 */
async function handleBlocks(
  payload: Extract<ToBackend, { type: `blocks:${string}` }>,
  userId?: string,
): Promise<void> {
  const blocks = await import('./tracker/blocks')
  let reason: string | undefined
  let view

  switch (payload.type) {
    case 'blocks:read':
      view = await blocks.readBlocks()
      break
    case 'blocks:move': {
      const result = await blocks.moveBlock(payload.tag, payload.direction)
      reason = result.reason
      view = result.view ?? await blocks.readBlocks()
      break
    }
    case 'blocks:enable': {
      const result = await blocks.setBlockEnabled(payload.tag, payload.enabled)
      reason = result.reason
      view = result.view ?? await blocks.readBlocks()
      break
    }
    case 'blocks:save': {
      const result = await blocks.saveCustomModule(payload)
      reason = result.reason
      view = result.view ?? await blocks.readBlocks()
      break
    }
    case 'blocks:delete': {
      const result = await blocks.deleteCustomModule(payload.tag)
      reason = result.reason
      view = result.view ?? await blocks.readBlocks()
      break
    }
    case 'blocks:prompt': {
      const result = await blocks.saveStockPrompt(payload.tag, payload.text)
      reason = result.reason
      view = result.view ?? await blocks.readBlocks()
      break
    }
    case 'blocks:prompt-reset': {
      const result = await blocks.resetStockPrompt(payload.tag)
      reason = result.reason
      view = result.view ?? await blocks.readBlocks()
      break
    }
  }

  send({ type: 'blocks:state', ...view, reason }, userId)
  if (payload.type !== 'blocks:read') {
    await renderPanel(userId)
    // A custom module's tag is a Display Group member key, so a rename or a
    // delete changes that editor too.
    if (payload.type === 'blocks:save' || payload.type === 'blocks:delete') {
      const groups = await import('./tracker/display-groups')
      send({ type: 'groups:state', ...(await groups.readDisplayGroups()) }, userId)
    }
  }
}

/** Every card-schema message. */
async function handleSections(
  payload: Extract<ToBackend, { type: `sections:${string}` }>,
  userId?: string,
): Promise<void> {
  const sections = await import('./tracker/sections')
  let reason: string | undefined
  let view

  switch (payload.type) {
    case 'sections:read':
      view = await sections.readSections(payload.target)
      break
    case 'sections:add': {
      const result = await sections.addSection(payload.target, payload.name)
      reason = result.reason
      view = result.view ?? await sections.readSections(payload.target)
      break
    }
    case 'sections:update': {
      const result = await sections.updateSection(payload.target, payload.id, payload)
      reason = result.reason
      view = result.view ?? await sections.readSections(payload.target)
      break
    }
    case 'sections:move': {
      const result = await sections.moveSection(payload.target, payload.id, payload.direction)
      reason = result.reason
      view = result.view ?? await sections.readSections(payload.target)
      break
    }
    case 'sections:delete': {
      const result = await sections.deleteSection(payload.target, payload.id)
      reason = result.reason
      view = result.view ?? await sections.readSections(payload.target)
      break
    }
    case 'sections:reset':
      view = await sections.resetSections(payload.target)
      break
  }

  send({ type: 'sections:state', ...view, reason }, userId)
}

/**
 * Every Display Groups message.
 *
 * They share a handler because they share an answer: each one changes the same
 * small structure and the panel needs the whole thing back, so returning
 * anything narrower would just mean a second round trip to redraw the editor.
 * A repaint follows any change, since grouping is what the panel draws.
 */
async function handleDisplayGroups(
  payload: Extract<ToBackend, { type: `groups:${string}` }>,
  userId?: string,
): Promise<void> {
  const groups = await import('./tracker/display-groups')
  let reason: string | undefined
  let view

  switch (payload.type) {
    case 'groups:read':
      view = await groups.readDisplayGroups()
      break
    case 'groups:enable':
      view = await groups.setDisplayGroupsEnabled(payload.enabled)
      break
    case 'groups:gaps':
      view = await groups.setDisplayGroupsShowGaps(payload.showGaps)
      break
    case 'groups:add': {
      const result = await groups.addDisplayGroup(payload.name, payload.member, payload.icon)
      reason = result.reason
      view = result.view ?? await groups.readDisplayGroups()
      break
    }
    case 'groups:rename': {
      const result = await groups.renameDisplayGroup(payload.id, payload.name, payload.icon)
      reason = result.reason
      view = result.view ?? await groups.readDisplayGroups()
      break
    }
    case 'groups:toggle':
      view = await groups.setDisplayGroupEnabled(payload.id, payload.enabled)
      break
    case 'groups:delete':
      view = await groups.deleteDisplayGroup(payload.id)
      break
    case 'groups:assign': {
      const result = await groups.assignDisplayModule(payload.tag, payload.groupId)
      reason = result.reason
      view = result.view ?? await groups.readDisplayGroups()
      break
    }
    case 'groups:move': {
      const result = await groups.moveDisplayMember(payload.id, payload.tag, payload.direction)
      reason = result.reason
      view = result.view ?? await groups.readDisplayGroups()
      break
    }
  }

  send({ type: 'groups:state', ...view, reason }, userId)
  if (payload.type !== 'groups:read') await renderPanel(userId)
}

/**
 * Send a clicked CYOA choice as the user's turn.
 *
 * Upstream typed the choice into SillyTavern's textarea and clicked send.
 * Here it is an ordinary user message with `triggerGeneration`, which runs the
 * same pipeline the chat input uses — so the interceptor, the state memo and
 * the tracker pass all behave exactly as they would for a typed turn.
 */
async function sendChoice(
  text: string,
  userId?: string,
  intoChatId?: string | null,
): Promise<void> {
  const chatId = chatMirror.getChatId()
  const content = String(text ?? '').trim()
  if (!chatId || !content) {
    spindle.log.warn('[DnD] ignoring CYOA choice with no active chat or empty text')
    return
  }
  // A caller that knows which chat its message belongs to says so, and the
  // comparison lives here — in the same synchronous block as the append —
  // rather than at the call site, where the chat can still move in the await
  // between checking and sending.
  if (intoChatId !== undefined && intoChatId !== chatId) {
    spindle.log.info(
      `[DnD] not sending into ${chatId}: that turn belongs to ${intoChatId ?? 'no chat'}`,
    )
    return
  }
  if (!spindle.permissions.has('chat_mutation')) {
    spindle.log.warn('[DnD] "chat_mutation" not granted — cannot send the choice')
    send({ type: 'toast', level: 'error', message: 'Grant chat_mutation to use choices.' }, userId)
    return
  }
  try {
    await spindle.chat.appendMessage(
      chatId,
      { role: 'user', content, metadata: { source: 'multihog_dnd', cyoa: true } },
      { triggerGeneration: true },
    )
  } catch (error) {
    spindle.log.error(`[DnD] sending CYOA choice failed: ${(error as Error).message}`)
    send({
      type: 'toast',
      level: 'error',
      message: `Could not send that choice: ${(error as Error).message}`,
    }, userId)
  }
}

/**
 * Register the dice tools with the host.
 *
 * `registerDiceFunctionTool()` reads `rngToolD20` / `rngToolD100` and registers
 * only what is enabled, unregistering the rest — so this is also how a settings
 * change takes effect. Safe to call repeatedly.
 */
async function syncDiceTools(): Promise<void> {
  if (!spindle.permissions.has('tools')) {
    spindle.log.warn('[DnD] "tools" not granted — tool-call dice unavailable')
    return
  }
  try {
    const hooks = await import('./engine/narrative-hooks.js') as {
      registerDiceFunctionTool?: () => void
    }
    hooks.registerDiceFunctionTool?.()
    const names = registeredToolNames()
    spindle.log.info(names.length
      ? `[DnD] dice tools active: ${names.join(', ')}`
      : '[DnD] no dice tools enabled (turn them on in settings)')
  } catch (error) {
    spindle.log.error(`[DnD] dice tool registration failed: ${(error as Error).message}`)
  }
}

/** Push the current scene: where the party is and who is with them. */
async function syncScene(userId?: string): Promise<void> {
  try {
    const [{ readScene }, { imageGenAvailable }] = await Promise.all([
      import('./tracker/immersion'),
      import('./tracker/portrait-gen'),
    ])
    send({
      type: 'scene:view',
      ...(await readScene()),
      canDraw: (await imageGenAvailable(userScope())).ok,
    }, userId)
  } catch (error) {
    spindle.log.error(`[DnD] scene sync failed: ${(error as Error).message}`)
  }
}

/** Push the panel palette. The frontend is what turns it into CSS. */
async function syncTheme(userId?: string): Promise<void> {
  try {
    const { readTheme } = await import('./tracker/theme')
    send({ type: 'theme:state', ...(await readTheme()) }, userId)
  } catch (error) {
    spindle.log.error(`[DnD] theme sync failed: ${(error as Error).message}`)
  }
}

/** Push saved configurations, and what the current one holds. */
async function syncCartridges(userId?: string): Promise<void> {
  try {
    const { describeCurrent, listCartridges } = await import('./tracker/cartridges')
    send({
      type: 'cartridge:state',
      cartridges: await listCartridges(),
      current: await describeCurrent(),
    }, userId)
  } catch (error) {
    spindle.log.error(`[DnD] cartridge sync failed: ${(error as Error).message}`)
  }
}

/** Push the NPC library to the panel. */
async function syncLibrary(userId?: string): Promise<void> {
  try {
    const { listLibrary } = await import('./tracker/npc-library')
    send({ type: 'npc:library', cards: await listLibrary() }, userId)
  } catch (error) {
    spindle.log.error(`[DnD] NPC library sync failed: ${(error as Error).message}`)
  }
}

/** Push the agent's record types to the settings surface. */
async function syncModules(userId?: string): Promise<void> {
  try {
    const { listModules } = await import('./tracker/modules')
    send({ type: 'modules:state', modules: await listModules() }, userId)
  } catch (error) {
    spindle.log.error(`[DnD] module sync failed: ${(error as Error).message}`)
  }
}

/**
 * Push the narrator ruleset's sections to the settings surface.
 *
 * The assembled size goes with it: the ruleset is ~25 KB of every prompt, and a
 * user turning sections off is usually doing it to get that number down.
 */
async function syncSysprompt(userId?: string): Promise<void> {
  try {
    const { buildSysprompt, listGameSystems, listSections } =
      await import('./tracker/sysprompt')
    send({
      type: 'sysprompt:sections',
      sections: await listSections(),
      systems: await listGameSystems(),
      size: (await buildSysprompt()).length,
    }, userId)
  } catch (error) {
    spindle.log.error(`[DnD] ruleset sync failed: ${(error as Error).message}`)
  }
}

/**
 * Push the companion conversation to the panel.
 *
 * The transcript is engine state, so the panel is a view of it rather than a
 * second copy — after a chat switch there is only one history to be right.
 */
async function syncCompanion(userId?: string, busy = false): Promise<void> {
  try {
    const {
      isCompanionBusy, readCompanionHistory, readCompanionPrefs,
    } = await import('./tracker/companion')
    send({
      type: 'companion:state',
      history: await readCompanionHistory(),
      prefs: await readCompanionPrefs(),
      busy: busy || isCompanionBusy(),
    }, userId)
  } catch (error) {
    spindle.log.error(`[DnD] companion sync failed: ${(error as Error).message}`)
  }
}

/**
 * Offer the Map Architect tool to the narrator model.
 *
 * Nothing here creates a map directly: the model calls `CreateAreaMap` when the
 * story enters somewhere worth mapping, and `onGenerationEnded` then keeps that
 * map current through the updater and evolution passes it was already calling.
 */
async function syncMapRuntime(): Promise<void> {
  try {
    const { syncMapRuntime: sync } = await import('./tracker/maps')
    const status = await sync()
    if (status.toolRegistered) {
      spindle.log.info('[DnD] persistent maps active — CreateAreaMap offered to the model')
    } else {
      spindle.log.info(`[DnD] persistent maps inactive: ${status.reason ?? 'unknown'}`)
    }
  } catch (error) {
    spindle.log.error(`[DnD] map runtime sync failed: ${(error as Error).message}`)
  }
}

async function installTrackerInterceptor(): Promise<void> {
  if (!spindle.permissions.has('interceptor')) {
    spindle.log.warn('[DnD] "interceptor" not granted — state memo will not be injected')
    return
  }
  try {
    const hooks = await import('./engine/narrative-hooks.js') as {
      installInterceptor?: () => void
    }
    hooks.installInterceptor?.()
    const installed = (globalThis as { rpgTrackerInterceptor?: TrackerInterceptor })
      .rpgTrackerInterceptor
    if (!installed) {
      spindle.log.warn('[DnD] installInterceptor() did not publish rpgTrackerInterceptor')
      return
    }
    spindle.registerInterceptor(adaptInterceptor(installed), 50)
    spindle.log.info('[DnD] tracker interceptor registered')
  } catch (error) {
    spindle.log.error(`[DnD] interceptor install failed: ${(error as Error).message}`)
  }
}

async function boot(): Promise<void> {
  // Synchronous, and before any engine import: engine modules read
  // `localStorage` while initialising. Contents arrive with the user.
  installBrowserEnv()
  installCompatGlobals()

  teardowns.push(bridgeHostEvents())
  teardowns.push(routeFrontendMessages())

  /*
   * Keep the mirror pointed at whatever chat the user is in.
   *
   * The two events are not synonyms, and treating them as one was a bug.
   * `CHAT_SWITCHED` is the switch: the host emits it when the active chat
   * setting changes, as `{ chatId }`, and a null id genuinely means "no chat".
   * `CHAT_CHANGED` is an *update* to a chat — a rename, a metadata write, an
   * avatar switch, messages reattributed to a persona — and mostly arrives as
   * `{ chat, changedFields }` with no `chatId` at all.
   *
   * Both used to go through `syncActiveChat(payload.chatId ?? null)`, so every
   * routine update read as "switched to no chat": the mirror detached, the
   * context went null, and every pass in flight was stopped — a tracker pass
   * running while the host renamed the chat lost that turn's update. Upstream
   * hit the same thing from the other side; its handler comments that a bare
   * CHAT_CHANGED "used to wipe currentMemo/memoHistory".
   */
  teardowns.push(spindle.on('CHAT_SWITCHED', (raw: unknown, userId?: string) => {
    setActiveUser(userId)
    const payload = raw as { chatId?: string | null }
    void syncActiveChat(payload?.chatId ?? null)
  }))
  teardowns.push(spindle.on('CHAT_CHANGED', (raw: unknown, userId?: string) => {
    setActiveUser(userId)
    const payload = raw as { chatId?: string | null, chat?: { id?: string, metadata?: unknown } | null }
    const chatId = payload?.chatId ?? payload?.chat?.id ?? null
    // Loom saves its summary into the chat's metadata, and the update carries
    // the chat — so a new summary is known the moment it is saved, for any chat.
    if (chatId && payload?.chat?.metadata !== undefined) {
      void import('./tracker/loom').then(({ noteChatMetadata }) => {
        if (noteChatMetadata(chatId, payload.chat!.metadata) && chatId === openChat()) void syncStory(userId)
      })
    }
    // An update to a chat that is not open is none of the tracker's business,
    // and an update naming no chat is a refresh signal, never a switch.
    if (!chatId || chatId !== openChat()) return
    void (async () => {
      // The open chat changed underneath us: its card, its persona, its
      // messages (a reattribution renames them) may all have moved. This is
      // the non-switching path — nothing is stopped and nothing is flushed.
      await syncActiveChat(chatId)
      await chatMirror.refresh()
    })().catch(error => {
      spindle.log.warn(`[DnD] refreshing the open chat failed: ${(error as Error).message}`)
    })
  }))
  /*
   * Forking is the host's gesture; carrying the campaign is ours.
   *
   * Upstream owns both — its "Branch Campaign" button calls SillyTavern's
   * `createBranch()` and then copies the state. There is no API to fork a chat
   * here, but Lumiverse tells us when the user forks one, which is the better
   * split: this covers every fork made through the host's own UI, not just the
   * ones started from a button of ours.
   *
   * Without it a forked chat opens with no character, no lore, and every NPC
   * back at zero.
   */
  /*
   * A chat was deleted. Clean up the campaign it leaves behind — its saved
   * state at once, its lorebooks only if the user agrees. See
   * `tracker/chat-cleanup.ts`.
   */
  teardowns.push(spindle.on('CHAT_DELETED', (raw: unknown, userId?: string) => {
    setActiveUser(userId)
    setPopupUser(userId)
    const payload = raw as { id?: string, chatId?: string }
    const chatId = payload?.id ?? payload?.chatId
    if (!chatId) return
    // Before the first await: a switch away from this chat can already be in
    // flight, and must not save it on the way out.
    deletedChats.add(chatId)
    pendingTurns.delete(chatId)
    void import('./tracker/loom').then(({ forgetLoomSummary }) => forgetLoomSummary(chatId))
    // If it was the open chat — or the one a queued switch is heading to —
    // there is no chat open now. Decided here, synchronously: the host may
    // already have asked for a switch elsewhere, and that one must win.
    const leave = openChat() === chatId ? syncActiveChat(null) : null
    void (async () => {
      await leave
      // Clean up only once every queued switch is done with the chat.
      await afterQueuedSwitches()
      const { cleanDeletedChat } = await import('./tracker/chat-cleanup')
      const result = await cleanDeletedChat(chatId)
      if (result.removed.length) {
        await saveSettings()
        send({
          type: 'toast', level: 'info',
          message: describeCleanup(result, ''),
        }, userId)
      }
    })().catch(error => {
      spindle.log.error(`[DnD] cleaning up a deleted chat failed: ${(error as Error).message}`)
    })
  }))

  /*
   * A Loom run finished. The summary is usually saved — and announced by
   * CHAT_CHANGED — just after; dropping what is known means the next read asks
   * the host either way, whichever arrives first.
   */
  teardowns.push(spindle.on('SUMMARIZATION_COMPLETED', (raw: unknown, userId?: string) => {
    setActiveUser(userId)
    const chatId = (raw as { chatId?: string } | null)?.chatId
    if (!chatId) return
    void import('./tracker/loom').then(({ forgetLoomSummary }) => {
      forgetLoomSummary(chatId)
      if (chatId === openChat()) void syncStory(userId)
    })
  }))

  teardowns.push(spindle.on('CHAT_FORKED', (raw: unknown, userId?: string) => {
    setActiveUser(userId)
    const payload = raw as { sourceChatId?: string; forkedChatId?: string }
    if (!payload?.sourceChatId || !payload?.forkedChatId) return
    const forked = payload.forkedChatId
    // Before the first await: the switch into the fork can arrive at any point
    // from here on, and has to find the fork already marked.
    branchesBeingSeeded.add(forked)
    void (async () => {
      const { carryCampaignToFork } = await import('./tracker/branching')
      const result = await carryCampaignToFork(payload.sourceChatId!, forked)
      if (!result.ok) {
        // Not always a problem — a chat with no campaign has nothing to carry.
        spindle.log.info(`[DnD] fork not carried: ${result.reason ?? 'unknown'}`)
        return
      }
      await saveSettings()
      for (const problem of result.errors) spindle.log.warn(`[DnD] fork: ${problem}`)
      send({
        type: 'toast',
        level: 'success',
        message: result.cloned
          ? `Campaign carried into the branch — ${result.cloned} lorebook(s) copied.`
          : 'Campaign carried into the branch.',
      }, userId)
    })().catch(error => {
      spindle.log.error(`[DnD] carrying the campaign failed: ${(error as Error).message}`)
    }).finally(async () => {
      branchesBeingSeeded.delete(forked)
      // If the user is already in the fork, it was spared the new-chat reset
      // while the carry ran. Now project what it should hold: the carried
      // campaign, or — when there was nothing to carry — a clean one.
      if (chatMirror.getChatId() !== forked) return
      try {
        const settings = await currentSettings()
        const carried = !!(settings.chatStates as Record<string, unknown> | undefined)?.[forked]
        if (carried) await loadChatState(forked)
        else await projectUnseenChat(forked, false)
        const { loadCompanionFor } = await import('./tracker/companion')
        await loadCompanionFor(forked)
        await saveSettings()
        await renderPanel(userId)
      } catch (error) {
        spindle.log.warn(`[DnD] projecting the fork failed: ${(error as Error).message}`)
      }
    })
  }))

  for (const event of ['MESSAGE_SENT', 'MESSAGE_EDITED', 'MESSAGE_SWIPED'] as const) {
    teardowns.push(spindle.on(event, (raw: unknown, userId?: string) => {
      setActiveUser(userId)
      const payload = raw as {
        chatId?: string
        message?: { id?: string; chat_id?: string; content?: string; swipe_id?: number }
      }
      const message = payload?.message
      if (!message?.id) return
      /*
       * Only the open chat's messages belong in the mirror. Every message
       * event names its chat, and the mirror used to take them all: a reply
       * finishing in a chat the user had left was saved, the host announced
       * the save, and the message was appended to the chat in front of them —
       * where the next tracker pass read another story as this one's latest.
       */
      const chatId = payload.chatId ?? message.chat_id
      if (!chatId || chatId !== chatMirror.getChatId()) return
      const before = chatMirror.messages.find(entry => entry._lvId === message.id)
      const was = before ? { mes: before.mes, swipe: before.swipe_id } : null
      chatMirror.applyIncoming(message as never)
      if (event === 'MESSAGE_SENT') return
      const now = chatMirror.messages.find(entry => entry._lvId === message.id)
      // Upstream reacts to a swipe or an edit. The host also reports every
      // extras-only write — including the tracker's own markers coming back —
      // as an edit, and those change nothing a reader would see.
      const changed = event === 'MESSAGE_SWIPED'
        || (!!was && !!now && (was.mes !== now.mes || was.swipe !== now.swipe_id))
      if (changed) void runMessageChange()
    }))
  }
  // Generation lifecycle. The engine's own `onGenerationEnded()` owns the whole
  // post-turn pipeline — throttling, the keyword accumulator, the tracker pass,
  // the Lorebook Agent, World Progression — so the port hands off to it rather
  // than inventing a trigger and drifting from upstream behaviour.
  teardowns.push(spindle.on('GENERATION_STARTED', (raw: unknown, userId?: string) => {
    setActiveUser(userId)
    void (async () => {
      const hooks = await import('./engine/narrative-hooks.js') as {
        onGenerationStarted?: (type?: string) => void
      }
      const payload = raw as { generationType?: string }
      hooks.onGenerationStarted?.(payload?.generationType)
    })().catch(error => {
      spindle.log.warn(`[DnD] onGenerationStarted failed: ${(error as Error).message}`)
    })
  }))

  /*
   * A turn ends either way. Upstream runs the same pipeline on
   * GENERATION_STOPPED as on GENERATION_ENDED: a stopped reply is kept, and
   * the story goes on from it. Lumiverse emits one or the other, never both.
   * A stop before anything was written leaves no reply, and nothing to track.
   */
  const onTurnEnded = (stopped: boolean) => (raw: unknown, userId?: string): void => {
    setActiveUser(userId)
    const payload = raw as {
      chatId?: string; messageId?: string; generationType?: string; error?: string; content?: string
    }
    if (stopped && !String(payload?.content ?? '').trim()) return
    // Where the user is, counting a switch already asked for. Postponed only
    // when that is another chat: with none open — before the first attach, or
    // after an account-wide "no chat" from some other tab — following the
    // event takes nobody's campaign away from them.
    const here = openChat()
    if (payload?.chatId && here && payload.chatId !== here) {
      postponeTurn(payload, userId)
      return
    }
    void (async () => {
      await ensureUserState()
      if (payload?.chatId) await syncActiveChat(payload.chatId)
      else await chatMirror.refresh()
      await runPostTurn()
    })().catch(error => {
      spindle.log.error(`[DnD] post-generation pipeline failed: ${(error as Error).message}`)
    })
  }
  teardowns.push(spindle.on('GENERATION_ENDED', onTurnEnded(false)))
  teardowns.push(spindle.on('GENERATION_STOPPED', onTurnEnded(true)))

  teardowns.push(spindle.on('MESSAGE_DELETED', (raw: unknown, userId?: string) => {
    setActiveUser(userId)
    const payload = raw as { messageId?: string }
    if (payload?.messageId) chatMirror.applyDeletion(payload.messageId)
  }))

  // Everything below needs to act *for someone*. Operator-scoped extensions get
  // no user at boot — the id only arrives alongside the first event — so this
  // waits rather than calling with `undefined` and logging three failures.
  onUserResolved(() => {
    void (async () => {
      await ensureUserState()
      try {
        const active = await spindle.chats.getActive(userScope())
        await syncActiveChat(active?.id ?? null)
      } catch (error) {
        spindle.log.warn(`[DnD] no active chat: ${(error as Error).message}`)
      }

      if (spindle.permissions.has('world_books')) {
        try {
          await updateWorldInfoList()
        } catch (error) {
          spindle.log.warn(`[DnD] world book index failed: ${(error as Error).message}`)
        }
      }

      await ensureStateConnection()
      // Every subsystem with its own connection follows the tracker's until
      // the user picks one, so this has to come after it is resolved.
      const { inheritConnections } = await import('./tracker/connections')
      inheritConnections(await currentSettings())
      await syncDiceTools()
      // Must come after ensureStateConnection: the map subsystems inherit the
      // tracker's connection, so it has to be resolved first.
      await syncMapRuntime()
    })().catch(error => {
      spindle.log.error(`[DnD] deferred startup failed: ${(error as Error).message}`)
    })
  })

  // Must precede the interceptor: engine modules call runtime actions as soon
  // as they run, and an unfilled table throws rather than degrading.
  await installRuntimeActions({
    refreshPanel: () => { void renderPanel() },
    setStatus: (running, label) => send({ type: 'panel:status', running, label }),
  })

  // The engine reaches the entry point through globals; without these
  // `onGenerationEnded()` bails at its first check and the agent never runs.
  const { runStatePass, isStatePassRunning } = await import('./tracker/state-pass')
  installEngineHooks({
    runStateModelPass: async () => { await runStatePass() },
    runFullAudit: async () => { await runAudit() },
    isStateModelRunning: () => isStatePassRunning(),
    refreshPanel: () => { void renderPanel() },
    currentChatId: () => chatMirror.getChatId() ?? '',
  })

  // The companion follows the chat, and `act_for_user` needs somewhere to send
  // a turn — the same path a CYOA choice takes.
  void import('./tracker/companion').then(({ installCompanionHooks }) =>
    installCompanionHooks(text => sendChoice(text)),
  ).catch(error => {
    spindle.log.error(`[DnD] companion hooks failed: ${(error as Error).message}`)
  })

  await installTrackerInterceptor()

  void eventSource.emit(event_types.APP_READY)
  spindle.log.info('[DnD] Multihog D&D Framework backend ready')
}

void boot()

export function teardown(): void {
  cancelAllPopups()
  unregisterAllTools()
  removeEngineHooks()
  void flushBrowserEnv()
  void flushRuntimeActions()
  for (const dispose of teardowns.splice(0)) {
    try {
      dispose()
    } catch {
      // Teardown is best effort; a failed unsubscribe must not block the rest.
    }
  }
}
