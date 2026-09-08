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
    const [factory, memo, renderer, stateManager, router, profiles] = await Promise.all([
      import('../engine/src/features/chat/chat-state-loader.js'),
      import('../engine/memo-processor.js'),
      import('../engine/renderer.js'),
      import('../engine/state-manager.js'),
      import('../engine/router.js'),
      import('../engine/src/state/profiles.js'),
    ]) as any[]

    loader = factory.createChatStateLoader({
      // ── real engine behaviour ──────────────────────────────────────────────
      getSettings: stateManager.getSettings,
      applyQuestSyncAndStripMemo: memo.applyQuestSyncAndStripMemo,
      extractCurrentTimeStr: memo.extractCurrentTimeStr,
      parseInWorldTime: memo.parseInWorldTime,
      formatInWorldTime: memo.formatInWorldTime,
      sanitizeRouterState: stateManager.sanitizeRouterState,
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
      resetAutoGenerationTracking: noop,
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
 * Returns false when the chat has no snapshot yet — a new chat, which keeps
 * whatever is live rather than blanking it.
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
