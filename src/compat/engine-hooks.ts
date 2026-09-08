/**
 * engine-hooks.ts — the `globalThis._rpg*` callbacks the engine orchestrates through.
 *
 * `narrative-hooks.js` owns the entire post-generation pipeline: it decides
 * whether this turn counts, throttles the Lorebook Agent by `runEvery`, keeps
 * the keyword-trigger accumulator and the run watermark, fires the State
 * Tracker pass, then the agent, then World Progression. It reaches back into
 * the application entry point through globals rather than imports, to avoid an
 * ESM cycle:
 *
 *     if (typeof globalThis._rpgRunStateModelPass !== 'function') { … bail … }
 *     await globalThis._rpgRunStateModelPass(narrative, isFullAudit, lookback)
 *
 * Upstream's `index.js` installs them. The port replaces `index.js`, so without
 * this module `onGenerationEnded()` bails at its first check and the Lorebook
 * Agent never runs — the same silent-no-op shape as the unfilled runtime action
 * table.
 *
 * Installing these is also what gives the agent its real scheduler, rather than
 * the port inventing a trigger and quietly diverging from upstream behaviour.
 */

export interface EngineHookBindings {
  /** Run the State Tracker pass. */
  runStateModelPass(
    narrative?: unknown,
    isFullAudit?: boolean,
    customLookback?: number | null,
  ): Promise<void>
  /** Rebuild the memo from the whole chat, in chunks. */
  runFullAudit(): Promise<void>
  /** Whether a tracker pass is in flight — the pipeline refuses to overlap. */
  isStateModelRunning(): boolean
  /** Repaint the tracker panel. */
  refreshPanel(): void
  /** The active chat, for engine paths that resolve it through a global. */
  currentChatId(): string
}

type Global = Record<string, unknown>

/** Hooks belonging to subsystems the port has not reached. */
const UNPORTED_NO_OPS = [
  // The frontend owns CYOA rendering now; nothing to finalise on the backend.
  '_rpgFinalizeCyoaNarratorRender',
  /*
   * Auto-generating scene art on arrival. Deliberately still inert: upstream
   * fires this whenever the party enters somewhere new, which on a paid image
   * endpoint is a bill nobody asked for. Drawing a scene is a button in the
   * Scene panel instead.
   */
  '_rpgCheckRealtimeSceneArt',
  '_rpgSyncAgentImmersionUi',
  // Settings-drawer surfaces that no longer exist.
  '_rpgSyncDynamicRngPrompt',
  '_rpgRefreshAgentManifest',
  // Raw-textarea flush: the panel is read-only, so there is nothing pending.
  '_rpgFlushRawMemoChanges',
  // Portrait migration lock — never locked, since portraits are not ported.
  '_rpgPortraitMigrationLocked',
] as const

const installed: string[] = []

export function installEngineHooks(bindings: EngineHookBindings): void {
  const target = globalThis as Global

  const set = (name: string, value: unknown): void => {
    target[name] = value
    installed.push(name)
  }

  set('_rpgRunStateModelPass', async (
    narrative?: unknown,
    isFullAudit?: boolean,
    customLookback?: number | null,
  ) => {
    // A full audit is a different operation, not a bigger pass: it re-reads
    // the whole chat in chunks and rebuilds the memo. Routing it to the
    // incremental pass would quietly answer a much weaker question.
    if (isFullAudit) {
      await bindings.runFullAudit()
      return
    }
    await bindings.runStateModelPass(narrative, isFullAudit, customLookback ?? null)
  })

  set('_rpgStateModelRunning', () => bindings.isStateModelRunning())

  // Panel repaints. The engine calls these after committing state.
  for (const name of [
    '_rpgRenderRouterUI', '_rpgUpdateUIMemo', '_rpgResetTrackerUi',
    // The router repaints its lorebook views after a pass; the panel is the
    // only view here.
    '_rpgRefreshLorebookAgentViews',
    // The scene view is a panel now, so it repaints like the others — the
    // party moving is exactly when it goes stale.
    '_rpgRefreshImmersionView',
  ]) {
    set(name, () => bindings.refreshPanel())
  }

  /*
   * The router and the map subsystems resolve the active chat as
   * `ctx.chatId || _rpgCurrentChatId()`. The port keeps `ctx.chatId` current,
   * but map data is written into per-chat lorebooks and partitions, so having
   * the fallback agree beats relying on one path always being right.
   */
  set('_rpgCurrentChatId', () => bindings.currentChatId())

  // The agent resets its own scheduler tick after a pass. The port drives
  // scheduling from the host's generation events, so there is nothing to reset.
  set('_rpgResetRouterAutoTick', () => false)

  for (const name of UNPORTED_NO_OPS) {
    set(name, () => false)
  }
}

/** Remove the hooks. Used on teardown so a reload does not see stale closures. */
export function removeEngineHooks(): void {
  const target = globalThis as Global
  for (const name of installed.splice(0)) delete target[name]
}
