/**
 * runtime-actions.ts — install the engine's runtime action table.
 *
 * `src/app/runtime-bridge.js` exists so feature modules can reach back into the
 * application entry point without importing it (which would be an ESM cycle).
 * The entry point — upstream's `index.js` — fills the table during startup:
 *
 *     configureRuntimeActions({ saveSettings, refreshRenderedView, ... })
 *
 * The port replaces `index.js`, so nothing was filling it. Every call went
 * through `invoke()`, which throws:
 *
 *     [RPG Tracker] Runtime action "saveSettings" was used before initialization.
 *
 * That surfaced as a tracker which *appeared* to work — the memo committed in
 * memory and the panel rendered it — while `saveChatState()` threw on every
 * pass and nothing reached disk. The state was lost on the next restart.
 *
 * Actions fall into three groups:
 *
 *   real     — `saveSettings` genuinely persists
 *   bridged  — UI refreshes that now mean "repaint the Spindle panel"
 *   inert    — DOM/jQuery calls with no meaning on a backend, made no-ops so
 *              the engine can call them without exploding
 *
 * Everything is registered explicitly. A silent catch-all would turn the next
 * missing action back into the invisible failure this file exists to fix.
 */

import { saveSettings as persistSettings, saveSettingsDebounced } from './settings-store'

/** Hooks the backend supplies so bridged actions can reach the frontend. */
export interface RuntimeActionHooks {
  /** Repaint the tracker panel. */
  refreshPanel(): void
  /** Report busy state to the panel. */
  setStatus(running: boolean, label?: string): void
}

let hooks: RuntimeActionHooks | null = null

/**
 * The installed hooks, for engine subsystems built outside the action table.
 *
 * The memo recovery manager is a factory taking its own repaint callbacks, so
 * it needs the same panel handle the action table uses rather than a second one
 * that could fall out of step.
 */
export function getRuntimeHooks(): RuntimeActionHooks | null {
  return hooks
}

/**
 * The router module, imported once at install.
 *
 * `isRouterRunning` is called synchronously from the scheduler, so it cannot
 * await a dynamic import at call time.
 */
interface RouterModule {
  isRouterRunning?: () => boolean
  /**
   * Loosely typed on purpose. The engine's signature is
   * `(narrative, manualPrompt = null, customLookback = null, isManual = false, …)`,
   * whose optional `null` parameters do not accept `unknown` — and the action
   * table forwards whatever the scheduler passes.
   */
  runRouterPass?: (...args: never[]) => Promise<unknown>
}

let routerModule: RouterModule | null = null

function noop(): void {
  // Inert on purpose — see the header.
}

export async function installRuntimeActions(next: RuntimeActionHooks): Promise<void> {
  hooks = next

  const bridge = await import('../engine/src/app/runtime-bridge.js') as {
    configureRuntimeActions?: (actions: Record<string, (...args: never[]) => unknown>) => void
  }

  if (typeof bridge.configureRuntimeActions !== 'function') {
    spindle.log.error('[DnD] runtime bridge has no configureRuntimeActions; persistence will fail')
    return
  }

  bridge.configureRuntimeActions({
    // ── real ────────────────────────────────────────────────────────────────
    // The engine calls this after every committed pass. Debounced, because a
    // single turn can commit several times.
    saveSettings: () => {
      saveSettingsDebounced()
    },

    // ── bridged to the Spindle panel ────────────────────────────────────────
    refreshRenderedView: () => hooks?.refreshPanel(),
    syncMemoView: () => hooks?.refreshPanel(),
    updateStatusIndicator: (state?: unknown, label?: unknown) => {
      const running = state === 'running'
      hooks?.setStatus(running, typeof label === 'string' ? label : undefined)
    },

    // ── inert: DOM and jQuery surfaces the frontend now owns ────────────────
    applyTrackerThemeToDom: noop,
    bindRenderedCardEvents: noop,
    syncLocationImageDependentUi: noop,
    syncNpcPortraitDependentUi: noop,
    syncTimeFormatSettingsUi: noop,
    setUseDdMmYyFormat: noop,
    // Not DOM chores, despite the names: both rewrite prompt text from the
    // current settings. As no-ops, "Quest deadlines" changed nothing in the
    // prompt and the relationship scale never reached the agent's NPC rule.
    refreshQuestPrompt: (settings?: unknown) => {
      void (async () => {
        const { refreshQuestPrompt } = await import('../tracker/stock-prompts')
        await refreshQuestPrompt(settings as Record<string, any> | undefined)
      })().catch(error => {
        spindle.log.warn(`[DnD] quest prompt refresh failed: ${(error as Error).message}`)
      })
    },
    rebuildNpcInstructionIfNeeded: () => {
      void (async () => {
        const { rebuildModuleInstructions } = await import('../tracker/stock-prompts')
        await rebuildModuleInstructions()
      })().catch(error => {
        spindle.log.warn(`[DnD] module instruction rebuild failed: ${(error as Error).message}`)
      })
    },
    // Returns a promise: `addPlayerCardToLorebookAgent` calls
    // `void refreshAgentManifestNow().catch(...)`, so a plain no-op returning
    // undefined throws "undefined is not an object".
    refreshAgentManifestNow: async () => {},

    // ── narrator ruleset ────────────────────────────────────────────────────
    // Upstream writes the assembled ruleset into SillyTavern's Main prompt
    // textarea. There is no preset to write into here, and none is needed: the
    // interceptor rebuilds it on every generation, so by the time anything asks
    // for it to be applied, it already has been. Repainting is all that is left.
    autoApplySysprompt: async () => {
      hooks?.refreshPanel()
    },
    fetchBaseSyspromptRaw: async () => {
      const { baseSyspromptText } = await import('../tracker/sysprompt')
      return baseSyspromptText()
    },
    // Character creation passes a system-prompt mode and its own connection
    // settings; ignoring them silently produced a sheet authored under the
    // State Extractor's diff rules against the wrong model.
    sendDirectPrompt: async (instruction?: unknown, options?: unknown) => {
      const { sendDirectPrompt: run } = await import('../tracker/direct-prompt')
      return run(String(instruction ?? ''), {
        ...(options as Record<string, unknown> ?? {}),
        rawPrompt: true,
        debugSource: 'CharacterCreator',
      })
    },
    // ── Lorebook Agent ──────────────────────────────────────────────────────
    runRouterPass: async (...args: unknown[]) =>
      routerModule?.runRouterPass?.(...(args as never[])),
    isRouterRunning: () => routerModule?.isRouterRunning?.() ?? false,
  })

  // The scheduler calls `isRouterRunning` synchronously, so resolve the module
  // now rather than at call time.
  try {
    routerModule = await import('../engine/router.js') as RouterModule
  } catch (error) {
    spindle.log.warn(`[DnD] router module unavailable: ${(error as Error).message}`)
  }

  spindle.log.info('[DnD] runtime actions installed')
}

/** Flush any debounced settings write. Used on teardown. */
export async function flushRuntimeActions(): Promise<void> {
  await persistSettings()
}
