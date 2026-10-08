/**
 * chat-state.ts — restore a chat's tracker snapshot when the user switches to it.
 *
 * The engine has always stored tracker state per chat, under
 * `settings.chatStates[chatId]` — memo, memo history, quests, delta, router
 * watermarks, the Lorebook Agent player card. `saveChatState(chatId)` writes it.
 *
 * The port called the save and never the load. That is worse than it sounds:
 * `settings.currentMemo` is a *projection* of one chat's state, so opening a
 * second chat showed the first chat's character — and the next commit wrote
 * that character into the second chat's partition. Characters were effectively
 * global, and switching chats could overwrite one campaign with another.
 *
 * Upstream's loader is a factory taking ~20 injected dependencies, because
 * `index.js` supplies them. Most are engine functions the port already has; the
 * rest are UI hooks that no longer exist here and become no-ops.
 */

type LoadChatState = (chatId: string) => boolean

let loader: LoadChatState | null = null

function noop(): void {
  // UI surfaces the frontend owns, or subsystems the port has not reached.
}

/** Build the loader once, wiring it to the engine's own helpers. */
async function build(): Promise<LoadChatState | null> {
  if (loader) return loader

  try {
    const [factory, memo, renderer, stateManager, router, profiles, portraits] = await Promise.all([
      import('../engine/src/features/chat/chat-state-loader.js'),
      import('../engine/memo-processor.js'),
      import('../engine/renderer.js'),
      import('../engine/state-manager.js'),
      import('../engine/router.js'),
      import('../engine/src/state/profiles.js'),
      import('../engine/portraits.js'),
    ]) as any[]

    loader = factory.createChatStateLoader({
      // ── real engine behaviour ──────────────────────────────────────────────
      getSettings: stateManager.getSettings,
      applyQuestSyncAndStripMemo: memo.applyQuestSyncAndStripMemo,
      extractCurrentTimeStr: memo.extractCurrentTimeStr,
      parseInWorldTime: memo.parseInWorldTime,
      formatInWorldTime: memo.formatInWorldTime,
      sanitizeRouterState: stateManager.sanitizeRouterState,
      // Automatic art's "already seen" set. A no-op while that was unported;
      // now that it runs, a stale set would make the arriving chat's whole
      // cast look new on its first check, and draw every one of them.
      resetAutoGenerationTracking: portraits.resetAutoGenerationTracking,
      disableManagedEntries: router.disableManagedEntries,
      loadStockPromptsFromProfile: profiles.loadStockPromptsFromProfile
        ?? stateManager.loadStockPromptsFromProfile,

      // ── panel repaints ─────────────────────────────────────────────────────
      // The frontend re-renders from the committed memo, so these only need to
      // not throw; `syncActiveChat` triggers the repaint itself.
      syncMemoView: noop,
      refreshOrderList: noop,

      // ── unported subsystems ────────────────────────────────────────────────
      applyChatNpcRelMaxSettings: noop,
      applyChatTimeFormatSettings: noop,
      hydrateImmersionSceneArtPath: noop,
      syncLocationImageDependentUi: noop,
      syncNpcPortraitDependentUi: noop,
      scheduleAgentManifestRefresh: noop,
      scheduleAutoApply: noop,
      // Upstream defers work to an idle callback; running it inline is correct
      // on a backend with no frame budget to protect.
      scheduleDeferred: (fn: unknown) => {
        if (typeof fn === 'function') {
          try {
            (fn as () => void)()
          } catch (error) {
            spindle.log.warn(`[DnD] deferred chat-state step failed: ${(error as Error).message}`)
          }
        }
      },
      // No agent panel here; upstream uses this to skip UI-only work.
      isAgentPanelVisible: () => false,
    })
  } catch (error) {
    spindle.log.error(`[DnD] chat state loader unavailable: ${(error as Error).message}`)
    return null
  }

  return loader
}

/**
 * Project the given chat's saved tracker state into the live settings.
 *
 * Returns false when the chat has no snapshot yet. The caller decides what a
 * new chat starts from — see `resetUnseenChatState`.
 */
export async function loadChatState(chatId: string | null): Promise<boolean> {
  if (!chatId) return false
  const load = await build()
  if (!load) return false
  try {
    return load(chatId)
  } catch (error) {
    spindle.log.error(`[DnD] loading chat state failed: ${(error as Error).message}`)
    return false
  }
}

/**
 * Persist the outgoing chat before switching away.
 *
 * Without this, an edit made since the last commit would be lost — and worse,
 * the live projection would still belong to the outgoing chat when the incoming
 * one has no snapshot to replace it.
 */
export async function saveChatStateFor(chatId: string | null): Promise<void> {
  if (!chatId) return
  try {
    const persistence = await import('../engine/src/state/chat-persistence.js') as {
      saveChatState?: (id: string) => unknown
    }
    persistence.saveChatState?.(chatId)
  } catch (error) {
    spindle.log.warn(`[DnD] saving outgoing chat state failed: ${(error as Error).message}`)
  }
}

/**
 * Give a chat with no saved state a clean campaign, as upstream does.
 *
 * The port used to leave whatever was live in place — "a new chat keeps
 * whatever is live rather than blanking it" — on the theory that blanking
 * loses something. What it actually did was start every new campaign as a
 * copy of the last one: the previous character sheet, its inventory, its quest
 * log, its portraits, its relationships, its memo history. The first tracker
 * pass of the new story then merged into all of that.
 *
 * Upstream calls `resetUnseenChatState()` here, from `index.js` — the file the
 * port replaces — so this is that function without its DOM half, field for
 * field. Its own note on scope stands: Narrator Configuration is deliberately
 * left alone, because the departing chat was already snapshotted and a new
 * chat should inherit how the user plays, not what they were playing.
 *
 * Two departures, both to keep the port's other fixes intact:
 *   - the clock format goes back to the default through
 *     `applyTimeFormatChange`, not by setting the flags alone, so the stored
 *     prompts are rewritten with it rather than left in the old format;
 *   - the companion is not touched here, because `loadCompanionFor` already
 *     gives an unseen chat an empty conversation.
 */
export async function resetUnseenChatState(chatId: string): Promise<void> {
  const [stateManager, immersion, chatSetup, relationshipMath, runtimeStateModule] =
    await Promise.all([
      import('../engine/state-manager.js'),
      import('../engine/immersion.js'),
      import('../engine/src/state/chat-setup.js'),
      import('../engine/src/state/relationship-math.js'),
      import('../engine/src/app/runtime-state.js'),
    ]) as any[]
  const s = stateManager.getSettings()

  // Ownership first, as upstream: anything that saves in the meantime persists
  // an identified new-chat state, never an ownerless one.
  s.chatStateProjectionOwner = chatId

  s.currentMemo = ''
  s.combatDefeatedUi = []
  s.prevMemo1 = ''
  s.prevMemo2 = ''
  s.memoHistory = []
  s.dungeonMapHistory = []
  s.lastDelta = ''
  s.historyIndex = -1
  s.quests = []
  s.activeRouterKeys = []
  s.activeWorldKeys = []
  s.keywordActivatedKeys = []
  s.routerLog = []
  s.pcCharacterBlockSeeded = false
  s.customPortraits = {}
  s.customLocationImages = {}
  s.worldProgressionLastFiredAtMinutes = -1
  s.worldProgressionLastFiredPeriodLabel = ''
  s.worldProgressionSkeletonAtmosphereSummary = ''
  s.worldProgressionLocationLastAdvanced = {}
  s.mapEvolutionLastFiredBySite = {}
  s.mapEvolutionBacklogBySite = {}
  s.mapEvolutionThreadsBySite = {}
  s.dungeonMapRevealAll = false
  s.mapEvolutionLastSiteRoot = ''
  s.mapEvolutionPendingExitRoot = ''
  s.mapEvolutionWorldReportApplications = {}
  s.agentImmersionMode = false
  immersion.resetImmersionSceneArtTracking?.()
  s.npcRelationshipValues = {}
  s.npcRelationshipLog = {}
  if (runtimeStateModule.runtimeState) runtimeStateModule.runtimeState.historyViewIndex = -1
  if (s.chatSetupLinkEnabled) chatSetup.clearChatBoundActivations(s)

  // `applyChatNpcRelMaxSettings(null)`: the new chat starts on the default scale.
  s.npcRelationshipMax = relationshipMath.getNpcRelationshipMaxDefault(s)

  // `applyChatTimeFormatSettings(null)`: the default clock, with the stored
  // prompts carried across if that is a change.
  const changed = {
    use24hTime: !!s.use24hTime,
    useDdMmYyFormat: !!s.useDdMmYyFormat,
  }
  s.use24hTime = false
  s.useDdMmYyFormat = false
  s.initialDate = 'Day 1'
  s.initialTime = '08:00 AM'
  const { applyTimeFormatChange, rebuildModuleInstructions } = await import('../tracker/stock-prompts')
  if (changed.use24hTime || changed.useDdMmYyFormat) {
    await applyTimeFormatChange(s, changed)
  } else {
    // Both applyChat… helpers end by rebuilding the agent's NPC instruction.
    await rebuildModuleInstructions()
  }
}

/**
 * Keep the departing chat's portraits and location art with that chat.
 *
 * Upstream treats these as chat-owned "even when broader Chat Link is off", so
 * this runs on every switch. With Chat Link on, `saveChatState` already writes
 * them into the partition; with it off, nothing else would.
 */
export async function snapshotPortraitsFor(chatId: string | null): Promise<void> {
  if (!chatId) return
  const [stateManager, scope] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/state/portrait-chat-scope.js'),
  ]) as any[]
  scope.snapshotPortraitMapsForChat(stateManager.getSettings(), chatId)
}

/**
 * Arrive in a chat with Chat Link off.
 *
 * Off means one campaign shared by every chat, so the memo, party and lore are
 * deliberately left as they are — nothing is loaded from the arriving chat's
 * partition. What upstream still resets is the state that belongs to a place
 * in a story rather than to the campaign: when World Progression and map
 * evolution last ran and where, the active world keys, and the quest list. Its
 * own words: that state "must never bleed between scenarios regardless of
 * chatLinkEnabled". Portraits follow the chat, as they always do.
 *
 * Upstream's link-off branch from `onChatChanged`, without the DOM.
 */
export async function applyUnlinkedSwitch(chatId: string): Promise<void> {
  const [stateManager, scope, portraits] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/state/portrait-chat-scope.js'),
    import('../engine/portraits.js'),
  ]) as any[]
  const s = stateManager.getSettings()
  scope.loadPortraitMapsForChat(s, chatId)
  // Auto-generation's "already seen" set is session-wide; without this the
  // arriving chat inherits it, and a check still running for the departing
  // chat keeps queueing against this one.
  portraits.resetAutoGenerationTracking?.()
  s.worldProgressionLastFiredAtMinutes = -1
  s.worldProgressionLastFiredPeriodLabel = ''
  s.worldProgressionSkeletonAtmosphereSummary = ''
  s.worldProgressionLocationLastAdvanced = {}
  s.mapEvolutionLastFiredBySite = {}
  s.mapEvolutionBacklogBySite = {}
  s.mapEvolutionThreadsBySite = {}
  s.dungeonMapRevealAll = false
  s.mapEvolutionLastSiteRoot = ''
  s.mapEvolutionPendingExitRoot = ''
  s.mapEvolutionWorldReportApplications = {}
  s.activeWorldKeys = []
  s.quests = []
}

export interface ChatLinkOutcome {
  /** False when the user backed out of the conflict: the setting is unchanged. */
  applied: boolean
  message?: string
}

/**
 * Turn Chat-Linked Mode on or off, as upstream's `applyChatLinkToggle` does.
 *
 * Off is just the flag: whatever campaign is live becomes the shared one.
 * On, inside a chat, binds the live campaign to that chat — and if the chat
 * already saved a *different* campaign, that is a real choice between two sets
 * of work, so it is asked rather than guessed: restore the chat's saved state,
 * keep the current session, or cancel. Whichever side loses goes into memo
 * history rather than being discarded, through upstream's own
 * `archiveDisplacedChatLinkMemo`.
 */
export async function applyChatLinkToggle(turningOn: boolean): Promise<ChatLinkOutcome> {
  const [stateManager, chatSetup, conflict, affinity] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/state/chat-setup.js'),
    import('../engine/src/features/chat/chat-link-conflict.js'),
    import('../engine/src/state/pass-affinity.js'),
  ]) as any[]
  const { chatMirror } = await import('./chat-mirror')
  const s = stateManager.getSettings()
  const chatId = chatMirror.getChatId()
  let message: string

  if (turningOn && chatId) {
    const ownsChat = affinity.createChatCommitGuard(chatId, () => chatMirror.getChatId())
    const saved = s.chatStates?.[chatId]
    // Re-enabling after carrying a setup into an unlocked chat adopts that
    // live setup rather than replacing it with factory stock.
    if (s.chatSetupLinkEnabled && saved && !saved.setup) saved.setup = chatSetup.snapshotChatSetup(s)

    const liveContent = String(s.currentMemo ?? '').trim()
    const savedContent = String(saved?.currentMemo ?? '').trim()
    const liveKeys = [...(s.activeRouterKeys ?? [])].sort()
    const savedKeys = [...(saved?.activeRouterKeys ?? [])].sort()
    const keysChanged = JSON.stringify(liveKeys) !== JSON.stringify(savedKeys)
    const setupChanged = !!s.chatSetupLinkEnabled && !!saved?.setup
      && !chatSetup.chatSetupsMatch(s, saved.setup)
    const hasConflict = (savedContent && liveContent && liveContent !== savedContent)
      || (savedKeys.length > 0 && liveKeys.length > 0 && keysChanged)
      || setupChanged

    if (hasConflict && saved) {
      const { callGenericPopup, POPUP_RESULT, POPUP_TYPE } = await import('./popup-bridge')
      const choice = await callGenericPopup(
        '<p><b>This chat already has a saved campaign, and it differs from the one '
          + 'loaded now.</b></p>'
          + '<p><b>Restore</b> uses this chat’s saved campaign; the current one is kept in history.<br>'
          + '<b>Overwrite</b> keeps the current campaign and saves it to this chat; the old one is kept in history.</p>',
        POPUP_TYPE.CONFIRM,
        '',
        {
          title: 'Chat Link conflict',
          okButton: 'Restore',
          cancelButton: 'Overwrite',
          customButtons: [{ text: 'Cancel', result: POPUP_RESULT.CANCELLED }],
        },
      )
      // The user may have switched chats while the question was open.
      if (!ownsChat()) return { applied: false, message: 'The chat changed — Chat Link left as it was.' }
      if (choice === POPUP_RESULT.AFFIRMATIVE) {
        conflict.archiveDisplacedChatLinkMemo(saved, s.currentMemo)
        await loadChatState(chatId)
        message = 'Chat Link on — restored this chat’s saved campaign.'
      } else if (choice === POPUP_RESULT.NEGATIVE) {
        conflict.archiveDisplacedChatLinkMemo(s, saved.currentMemo)
        await saveChatStateFor(chatId)
        message = 'Chat Link on — kept the current campaign and saved it to this chat.'
      } else {
        return { applied: false }
      }
    } else {
      if (!(await loadChatState(chatId))) await saveChatStateFor(chatId)
      message = 'Chat Link on — the campaign is now bound to this chat.'
    }
  } else if (turningOn) {
    message = 'Chat Link on.'
  } else {
    message = 'Chat Link off — one campaign now follows you across every chat.'
  }

  s.chatLinkEnabled = turningOn
  return { applied: true, message }
}
