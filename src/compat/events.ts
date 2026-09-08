/**
 * events.ts — SillyTavern `eventSource` / `event_types` emulation.
 *
 * The engine subscribes to 18 ST events. Some map straight onto a Lumiverse
 * event, some have no host counterpart and are synthesised by the port, and a
 * few (the prompt-assembly hooks) only exist inside the interceptor — those are
 * emitted from there so ported handlers keep working unchanged.
 */

export const event_types = {
  APP_READY: 'APP_READY',
  SETTINGS_LOADED: 'SETTINGS_LOADED',
  CHAT_CHANGED: 'CHAT_CHANGED',
  CHAT_LOADED: 'CHAT_LOADED',
  CHAT_RENAMED: 'CHAT_RENAMED',
  MESSAGE_SENT: 'MESSAGE_SENT',
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  MESSAGE_EDITED: 'MESSAGE_EDITED',
  MESSAGE_UPDATED: 'MESSAGE_UPDATED',
  MESSAGE_DELETED: 'MESSAGE_DELETED',
  MESSAGE_SWIPED: 'MESSAGE_SWIPED',
  MORE_MESSAGES_LOADED: 'MORE_MESSAGES_LOADED',
  GENERATION_STARTED: 'GENERATION_STARTED',
  GENERATION_ENDED: 'GENERATION_ENDED',
  GENERATION_STOPPED: 'GENERATION_STOPPED',
  STREAM_TOKEN_RECEIVED: 'STREAM_TOKEN_RECEIVED',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'GENERATE_BEFORE_COMBINE_PROMPTS',
  CHAT_COMPLETION_PROMPT_READY: 'CHAT_COMPLETION_PROMPT_READY',
  WORLD_INFO_UPDATED: 'WORLD_INFO_UPDATED',
} as const

export type StEventName = typeof event_types[keyof typeof event_types]

type Handler = (...args: unknown[]) => unknown | Promise<unknown>

/**
 * ST events that a Lumiverse event maps onto directly. Everything absent from
 * this table is either synthesised by the port or never fires — see
 * PORTING.md for the per-event rationale.
 */
const HOST_EVENT_MAP: Partial<Record<string, StEventName[]>> = {
  MESSAGE_SENT: [event_types.MESSAGE_SENT],
  MESSAGE_EDITED: [event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED],
  MESSAGE_DELETED: [event_types.MESSAGE_DELETED],
  MESSAGE_SWIPED: [event_types.MESSAGE_SWIPED],
  CHAT_CHANGED: [event_types.CHAT_CHANGED, event_types.CHAT_LOADED],
  CHAT_SWITCHED: [event_types.CHAT_CHANGED, event_types.CHAT_LOADED],
  GENERATION_STARTED: [event_types.GENERATION_STARTED],
  GENERATION_ENDED: [event_types.GENERATION_ENDED, event_types.MESSAGE_RECEIVED],
  GENERATION_STOPPED: [event_types.GENERATION_STOPPED],
  STREAM_TOKEN_RECEIVED: [event_types.STREAM_TOKEN_RECEIVED],
}

/** Events with no Lumiverse counterpart. Subscribing is legal; they never fire. */
export const UNSUPPORTED_EVENTS: StEventName[] = [
  event_types.CHAT_RENAMED,
  event_types.MORE_MESSAGES_LOADED,
]

class EventSourceShim {
  private handlers = new Map<string, Set<Handler>>()

  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
    if (UNSUPPORTED_EVENTS.includes(event as StEventName)) {
      spindle.log.info(`[DnD] subscribed to "${event}", which has no Lumiverse counterpart and will not fire.`)
    }
  }

  once(event: string, handler: Handler): void {
    const wrapper: Handler = async (...args) => {
      this.removeListener(event, wrapper)
      return handler(...args)
    }
    this.on(event, wrapper)
  }

  removeListener(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler)
  }

  /** ST awaits every handler in registration order; keep that contract. */
  async emit(event: string, ...args: unknown[]): Promise<void> {
    const set = this.handlers.get(event)
    if (!set?.size) return
    for (const handler of [...set]) {
      try {
        await handler(...args)
      } catch (error) {
        spindle.log.error(`[DnD] handler for "${event}" threw: ${(error as Error).message}`)
      }
    }
  }
}

export const eventSource = new EventSourceShim()

/** Wire Lumiverse host events into the shim. Returns an unsubscribe function. */
export function bridgeHostEvents(): () => void {
  const unsubs: Array<() => void> = []
  for (const [hostEvent, stEvents] of Object.entries(HOST_EVENT_MAP)) {
    if (!stEvents) continue
    unsubs.push(spindle.on(hostEvent, payload => {
      for (const stEvent of stEvents) void eventSource.emit(stEvent, payload)
    }))
  }
  return () => {
    for (const unsub of unsubs) unsub()
  }
}
