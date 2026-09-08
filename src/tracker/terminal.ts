/**
 * terminal.ts — instruct any subsystem directly.
 *
 * The panel's Ask box has only ever reached the State Tracker. Upstream's
 * terminal targets five: the tracker, the Lorebook Agent, and the three map
 * passes. Each already takes a direct instruction — this routes to the right
 * one rather than reimplementing any of them.
 *
 * Worth having because the automatic passes are scheduled and scoped, and
 * sometimes you know exactly what needs doing: "the inn burned down, update the
 * map", "re-read the last scene and record the NPCs you missed". Without this
 * the only lever is waiting for the next pass and hoping it notices.
 */

export const TERMINAL_TARGETS = [
  'tracker',
  'agent',
  'map_updater',
  'map_evolution',
  'map_architect',
] as const

export type TerminalTarget = typeof TERMINAL_TARGETS[number]

export interface TerminalResult {
  ok: boolean
  /** What to show back in the terminal. */
  output: string
}

/** Human-readable labels, so the panel does not have to know the ids. */
export const TARGET_LABELS: Record<TerminalTarget, string> = {
  tracker: 'State Tracker',
  agent: 'Lorebook Agent',
  map_updater: 'Map Updater',
  map_evolution: 'Map Evolution',
  map_architect: 'Map Architect',
}

/**
 * Send an instruction.
 *
 * `lookback` is how many recent messages the subsystem should read alongside
 * the instruction; `null` leaves it to that subsystem's own setting.
 */
export async function runTerminal(
  target: TerminalTarget,
  instruction: string,
  lookback: number | null = null,
): Promise<TerminalResult> {
  const text = String(instruction ?? '').trim()
  if (!text) return { ok: false, output: 'Nothing to send.' }
  if (!spindle.permissions.has('generation')) {
    return { ok: false, output: 'The generation permission is not granted.' }
  }

  const { inheritConnections } = await import('./connections')
  const stateManager = await import('../engine/state-manager.js') as unknown as {
    getSettings: () => Record<string, any>
  }
  inheritConnections(stateManager.getSettings())

  try {
    switch (target) {
      case 'tracker': {
        const { sendDirectPrompt } = await import('./direct-prompt')
        const result = await sendDirectPrompt(text)
        if (!result.ok) return { ok: false, output: result.reason ?? 'The pass failed.' }
        return {
          ok: true,
          output: result.changed
            ? 'State updated.'
            : 'The model replied, but nothing in the memo changed.',
        }
      }

      case 'agent': {
        const router = await import('../engine/router.js') as unknown as {
          runRouterPass: (
            narrative: unknown, manualPrompt?: string | null,
            customLookback?: number | null, isManual?: boolean,
          ) => Promise<unknown>
        }
        // `isManual` matters: it bypasses the run-every schedule, which is the
        // whole point of asking by hand.
        await router.runRouterPass(null, text, lookback, true)
        return { ok: true, output: 'Lorebook Agent pass finished — see Campaign Records.' }
      }

      case 'map_updater': {
        const updater = await import('../engine/map-updater.js') as unknown as {
          runMapUpdaterPass: (options: Record<string, unknown>) => Promise<Record<string, any>>
        }
        const result = await updater.runMapUpdaterPass({
          isManual: true, directInstruction: text, lookback,
        })
        return skipOrDone(result, 'Map updated.')
      }

      case 'map_evolution': {
        const evolution = await import('../engine/map-evolution.js') as unknown as {
          runMapEvolutionPass: (options: Record<string, unknown>) => Promise<Record<string, any>>
        }
        const result = await evolution.runMapEvolutionPass({
          isManual: true, directInstruction: text, lookback,
        })
        return skipOrDone(result, 'The site moved on.')
      }

      case 'map_architect':
        // The Architect builds a whole map from a structured brief, which is
        // what the CreateAreaMap tool exists to supply. A free-text instruction
        // has nowhere to go, and inventing a brief here would produce a map the
        // user did not describe.
        return {
          ok: false,
          output: 'The Map Architect is driven by the narrator calling '
            + 'CreateAreaMap, not by an instruction. Ask the story to enter '
            + 'somewhere worth mapping, or use the Adventure Companion.',
        }

      default:
        return { ok: false, output: `Unknown target: ${String(target)}` }
    }
  } catch (error) {
    return { ok: false, output: (error as Error).message }
  }
}

/**
 * A skipped pass is not a failure, and reporting it as one sends the user
 * hunting for a bug that is not there. The engine says why; pass it on.
 */
function skipOrDone(result: Record<string, any> | undefined, done: string): TerminalResult {
  const skipped = result?.skipped
  if (skipped) {
    return { ok: false, output: `Nothing to do — ${String(skipped).replace(/_/g, ' ')}.` }
  }
  return { ok: true, output: done }
}
