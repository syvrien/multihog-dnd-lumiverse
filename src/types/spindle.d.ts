/**
 * spindle.d.ts — bind the real Spindle types.
 *
 * This file used to carry a hand-written subset of the API, written from the
 * developer docs while no Lumiverse checkout was available. It has been
 * replaced by the published `lumiverse-spindle-types` package, which is the
 * authority — several members were subtly wrong in the hand-written version
 * (`ctx.ui.showModal` most notably, which returns a handle synchronously rather
 * than resolving to a result).
 *
 * Import DTOs directly from the package; this file only declares the global.
 */

import type { SpindleAPI } from 'lumiverse-spindle-types'

declare global {
  const spindle: SpindleAPI
}

export {}
