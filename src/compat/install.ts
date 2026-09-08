/**
 * install.ts — publish the compat surface on `globalThis`.
 *
 * The ported engine calls `SillyTavern.getContext()` in 283 places. Installing
 * the shim as a global is what lets those files come across with their import
 * lines rewritten and nothing else — the alternative was threading a context
 * parameter through every one of them.
 */

import { getContext } from './context'

export interface SillyTavernGlobal {
  getContext: typeof getContext
  libs: Record<string, unknown>
}

export function installCompatGlobals(libs: Record<string, unknown> = {}): void {
  const target = globalThis as typeof globalThis & { SillyTavern?: SillyTavernGlobal }
  target.SillyTavern = { getContext, libs }
}

