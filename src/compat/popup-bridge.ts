/**
 * popup-bridge.ts — SillyTavern `callGenericPopup()` over the frontend channel.
 *
 * 77 engine call sites await a popup result inline. The backend has no DOM, so
 * each call becomes a request/response round trip to the frontend, which renders
 * the popup with the host's own modal chrome and posts the result back.
 */

import { POPUP_RESULT, POPUP_TYPE, type ToFrontend } from '../shared/protocol'

export { POPUP_RESULT, POPUP_TYPE }

interface Pending {
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
let counter = 0

/** Popups wait on a human; the ceiling only exists so a lost reply cannot leak. */
const POPUP_TIMEOUT_MS = 10 * 60 * 1000

let activeUserId: string | undefined

export function setPopupUser(userId: string | undefined): void {
  activeUserId = userId
}

/**
 * ST signature: `callGenericPopup(content, type, inputValue?, options?)`.
 * Resolves to the popup result — a string for INPUT, a POPUP_RESULT otherwise.
 */
export function callGenericPopup(
  content: string,
  popupType: number = POPUP_TYPE.TEXT,
  inputValue = '',
  options: Record<string, unknown> = {},
): Promise<unknown> {
  const requestId = `popup_${++counter}_${Date.now()}`
  const message: ToFrontend = {
    type: 'popup:open',
    requestId,
    popupType,
    content,
    inputValue,
    options,
  }

  return new Promise<unknown>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve(POPUP_RESULT.CANCELLED)
    }, POPUP_TIMEOUT_MS)
    pending.set(requestId, { resolve, timer })
    spindle.sendToFrontend(message, activeUserId)
  })
}

/** Called by the backend message router when the frontend answers. */
export function resolvePopup(requestId: string, result: unknown): void {
  const entry = pending.get(requestId)
  if (!entry) return
  pending.delete(requestId)
  clearTimeout(entry.timer)
  entry.resolve(result)
}

/** Reject everything in flight — used on teardown. */
export function cancelAllPopups(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve(POPUP_RESULT.CANCELLED)
  }
  pending.clear()
}
