/**
 * animations.ts — the XP bar filling, and stat bars sliding.
 *
 * Upstream animates two things when the panel repaints: XP counts down from a
 * floating "+140 XP" into the bar, and a stat bar that moved trickles to its new
 * value instead of jumping. Both are in `src/ui/panel/**`, the directory this
 * port replaces — but `xp-gain-animation.js` and `bar-change-animation.js`
 * import nothing and assume nothing about SillyTavern. They read data attributes
 * off the rendered markup and drive `requestAnimationFrame`.
 *
 * That markup is already here: the panel is `renderer.js` output, and the ported
 * stylesheet already carries `rt-xp-gain-floater`, `rt-bar-animate` and the rest.
 * The animations were the only missing piece, so they run unmodified in the
 * frontend where a real `document` exists.
 *
 * ## Why the container has to be stable
 *
 * Both work by capturing the visible numbers *before* the markup is replaced and
 * replaying them into the new markup. That comparison is only meaningful if it
 * is the same panel showing the same chat, so upstream keys it on a context
 * string stamped onto the container. Repainting after a chat switch, or the
 * first paint of a session, must not animate — a bar sliding from another
 * campaign's values is worse than no animation.
 *
 * ## Reduced motion
 *
 * Both honour `prefers-reduced-motion` internally by shortening the trickle.
 * That is upstream's choice and it is kept: the count is information, so it is
 * slowed rather than removed.
 */

import {
  captureXpGainAnimationState, playXpGainAnimation,
} from '../engine/src/ui/panel/xp-gain-animation.js'
import {
  captureBarChangeAnimationState, playBarChangeAnimations,
} from '../engine/src/ui/panel/bar-change-animation.js'

export interface PanelAnimationState {
  xp: unknown
  bars: unknown
  key: string
}

/**
 * Read what is on screen, immediately before the markup is thrown away.
 *
 * `key` identifies what is being shown. Anything that changes it — a different
 * chat, a restored memo version — suppresses the animation rather than
 * animating between unrelated numbers.
 */
export function capturePanelAnimations(
  container: HTMLElement | null,
  key: string,
): PanelAnimationState {
  try {
    return {
      xp: captureXpGainAnimationState(container, key),
      bars: captureBarChangeAnimationState(container, key),
      key,
    }
  } catch (error) {
    console.warn('[DnD] could not capture panel animation state:', error)
    return { xp: null, bars: null, key }
  }
}

/**
 * Play the transitions into freshly rendered markup.
 *
 * Wrapped because this is decoration: an animation that throws must not take
 * the panel with it, and the final values are already in the DOM either way —
 * the animation only controls how they are arrived at.
 */
export function playPanelAnimations(
  container: HTMLElement | null,
  captured: PanelAnimationState | null,
): void {
  if (!container || !captured) return
  try {
    playXpGainAnimation(container, captured.xp as never, captured.key)
  } catch (error) {
    console.warn('[DnD] XP animation failed:', error)
  }
  try {
    playBarChangeAnimations(container, captured.bars as never, captured.key)
  } catch (error) {
    console.warn('[DnD] bar animation failed:', error)
  }
}
