/**
 * recovery.ts — a second copy of the memo, in case the first one is lost.
 *
 * `memoHistory` already covers "the last pass mangled the sheet". This covers
 * the worse case: the settings tree itself comes back short — a failed write, a
 * half-restored profile, a chat opened on a machine whose copy is stale — and
 * the memo you can see is smaller than the one you had.
 *
 * The engine keeps a rolling backup per chat and compares on chat open. Its
 * decision logic is deliberately conservative: it only offers a restore when
 * the backup is *meaningfully larger*, and it refuses to shrink the backup
 * behind your back. That judgement is the valuable part, so it comes across
 * unchanged rather than being re-derived here.
 *
 * The confirm is the engine's own, rendered through the port's popup host.
 * Restoring is destructive to what is on screen, so it stays a question — this
 * module never restores silently.
 *
 * In SillyTavern the backup lived in the browser's `localStorage`. Here that is
 * backed by `spindle.userStorage`, so it is per-user on the server rather than
 * per-browser — which makes it a better backup, not a worse one, but it no
 * longer protects against "this browser is the odd one out".
 */

interface RecoveryManager {
  snapshotMemoToLocalStorage: (chatId: string, options?: Record<string, unknown>) => void
  ensureLocalMemoRecovery: (chatId: string) => Promise<void>
  markBootCheckDone: () => void
  markMemoPersistedByCurrentBrowser: (settings?: unknown) => void
}

let manager: RecoveryManager | null = null

async function build(): Promise<RecoveryManager> {
  if (manager) return manager

  const [stateManager, recovery] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/features/recovery/memo-recovery.js'),
  ]) as any[]
  const { saveSettingsDebounced } = await import('../compat/settings-store')
  const { getRuntimeHooks } = await import('../compat/runtime-actions')

  manager = recovery.createMemoRecoveryManager({
    getSettings: stateManager.getSettings,
    saveSettings: () => saveSettingsDebounced(),
    // The panel is the view; these are the engine's names for repainting it.
    updateUIMemo: () => getRuntimeHooks()?.refreshPanel(),
    refreshRenderedView: () => getRuntimeHooks()?.refreshPanel(),
    syncMemoView: () => getRuntimeHooks()?.refreshPanel(),
    // Only used to build the confirm's message; the popup host escapes on
    // insertion anyway, so this is belt and braces rather than the guard.
    escapeHtml: (text: string) => String(text ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  }) as RecoveryManager
  return manager
}

/**
 * Check the backup for a chat being opened, and offer a restore if it looks
 * like the live memo has lost something.
 *
 * Runs once per session by the engine's own guard, so a chat switch later in
 * the same session does not re-prompt.
 */
export async function checkRecoveryOnOpen(chatId: string | null): Promise<void> {
  if (!chatId) return
  try {
    const recovery = await build()
    await recovery.ensureLocalMemoRecovery(chatId)
  } catch (error) {
    // A backup that cannot be read must never block opening a chat.
    spindle.log.warn(`[DnD] memo recovery check failed: ${(error as Error).message}`)
  }
}

/** Take a backup. Called after a commit, when there is something worth keeping. */
export async function snapshotMemo(chatId: string | null): Promise<void> {
  if (!chatId) return
  try {
    const recovery = await build()
    recovery.markMemoPersistedByCurrentBrowser()
    recovery.snapshotMemoToLocalStorage(chatId)
  } catch (error) {
    spindle.log.warn(`[DnD] memo snapshot failed: ${(error as Error).message}`)
  }
}
