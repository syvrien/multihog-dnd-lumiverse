/**
 * st-core.ts — the handful of symbols the engine imports from SillyTavern
 * *core* rather than from `getContext()`.
 *
 * Measured against upstream, this is only 7 import lines across 6 files:
 *
 *   getRequestHeaders          index.js, router.js, character-creator.js, portrait-storage.js
 *   getSortableDelay           game-systems.js
 *   POPUP_RESULT               game-systems.js
 *   SlashCommandAbortController portraits.js
 *
 * The port script rewrites all four import paths to this module.
 */

export { POPUP_RESULT } from '../shared/protocol'

/**
 * SillyTavern's auth headers for its own REST API.
 *
 * This used to throw, on the reasoning that every caller was reaching an
 * endpoint that does not exist here. That stopped being true once
 * `worldinfo-rest.ts` began serving `/api/worldinfo/{list,get,edit,delete}`
 * in-process: those callers reach a real implementation now, and throwing here
 * blocked them over a header the shim ignores. It cost the Map Architect its
 * save — the map generated and validated, then died on the write.
 *
 * The guard belongs one layer down, and is already there: `installFetchShim()`
 * rejects every SillyTavern endpoint it does not implement, **by name**, so an
 * unported call site still fails loudly and says which route it wanted.
 */
export function getRequestHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

/** SillyTavern's jQuery-UI sortable delay. Touch gets a delay, mouse does not. */
export function getSortableDelay(): number {
  return 50
}

/**
 * SillyTavern's abort controller for slash-command pipelines. The engine only
 * uses `.signal` and `.abort()`, both of which `AbortController` already gives.
 */
export class SlashCommandAbortController extends AbortController {
  get isAborted(): boolean {
    return this.signal.aborted
  }
}

/**
 * SillyTavern's in-memory world info cache (`world-info.js`). `router.js`
 * evicts and repopulates it around its own writes so ST's editor does not serve
 * stale books. The compat world-info bridge holds its own cache, so this Map
 * exists only to keep those call sites working; every use upstream is wrapped
 * in try/catch with a documented fallback.
 */
export const worldInfoCache = new Map<string, unknown>()
