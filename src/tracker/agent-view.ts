/**
 * agent-view.ts — what the Lorebook Agent has been doing, and what it is
 * currently feeding the narrator.
 *
 * Both of these have been written the whole time and read by nothing.
 *
 *   `settings.routerLog`         one entry per pass, with what it changed
 *   `settings.activeRouterKeys`  the entries being injected right now
 *
 * The agent is the least legible part of the framework: it runs on its own
 * schedule, edits lorebooks in the background, and decides what rides along in
 * every prompt. Showing its recent passes and its active set is the difference
 * between trusting it and hoping.
 *
 * Deactivating a key here is a real lever, not a debug view — an entry that
 * should not be in the prompt is costing tokens on every single turn.
 */

interface LogEntry {
  time: string
  reason: string
  /** Entry ids the pass switched on, off, wrote, rewrote or deleted. */
  activated: number
  deactivated: number
  recorded: number
  rewritten: number
  deleted: number
}

export interface ActiveKey {
  id: string
  book: string
  label: string
  pinned: boolean
}

export interface AgentView {
  ok: boolean
  reason?: string
  running: boolean
  log: LogEntry[]
  keys: ActiveKey[]
  /** The cap from settings, so a full set reads as full rather than broken. */
  maxActive: number
}

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0)

export async function readAgentView(): Promise<AgentView> {
  const empty: AgentView = { ok: false, running: false, log: [], keys: [], maxActive: 0 }
  try {
    const [stateManager, router] = await Promise.all([
      import('../engine/state-manager.js'),
      import('../engine/router.js'),
    ]) as any[]
    const settings = stateManager.getSettings()

    const log: LogEntry[] = (settings.routerLog ?? [])
      .slice(0, 25)
      .map((entry: Record<string, unknown>) => ({
        time: String(entry.time ?? ''),
        reason: String(entry.reason ?? ''),
        activated: countOf(entry.activate),
        deactivated: countOf(entry.deactivate),
        recorded: countOf(entry.record),
        rewritten: countOf(entry.rewrite),
        deleted: countOf(entry.delete),
      }))

    const pinned = new Set<string>(settings.pinnedRouterKeys ?? [])
    const keys: ActiveKey[] = [
      ...(settings.activeRouterKeys ?? []),
      ...(settings.activeWorldKeys ?? []),
    ].map((id: string) => {
      const [book, uid] = String(id).split('::')
      return {
        id: String(id),
        book: String(book ?? ''),
        // The uid alone means nothing to a reader; the book name at least says
        // what kind of thing it is.
        label: `${String(book ?? '').replace(/^.*?_/, '')} #${uid ?? '?'}`,
        pinned: pinned.has(String(id)),
      }
    })

    return {
      ok: true,
      running: typeof router.isRouterRunning === 'function' ? !!router.isRouterRunning() : false,
      log,
      keys,
      maxActive: Number(settings.routerMaxActivations) || 0,
    }
  } catch (error) {
    return { ...empty, reason: (error as Error).message }
  }
}

/**
 * Drop one entry from the active set.
 *
 * It stays in its lorebook — this takes it out of the prompt, which is the
 * thing costing tokens. The agent may reactivate it on a later pass if the
 * story calls for it, which is correct: this is a nudge, not a ban.
 */
export async function deactivateKey(id: string): Promise<{ ok: boolean; reason?: string }> {
  const key = String(id ?? '').trim()
  if (!key) return { ok: false, reason: 'no entry given' }
  try {
    const stateManager = await import('../engine/state-manager.js') as unknown as {
      getSettings: () => Record<string, any>
    }
    const settings = stateManager.getSettings()
    const drop = (list: unknown): string[] =>
      (Array.isArray(list) ? list : []).filter((entry: string) => entry !== key)

    settings.activeRouterKeys = drop(settings.activeRouterKeys)
    settings.activeWorldKeys = drop(settings.activeWorldKeys)
    // A pinned key would be put straight back by the next reconcile.
    settings.pinnedRouterKeys = drop(settings.pinnedRouterKeys)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}
