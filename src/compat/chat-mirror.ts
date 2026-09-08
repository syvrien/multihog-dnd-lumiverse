/**
 * chat-mirror.ts — SillyTavern `ctx.chat` emulation.
 *
 * SillyTavern hands extensions a live, synchronously mutable array of messages
 * and expects `saveChat()` afterwards. Lumiverse exposes messages only through
 * async RPC (`spindle.chat.*`). The ported engine reads `ctx.chat` in 56 places
 * and mutates it in several, so the port keeps a mirror array:
 *
 *   read  — the mirror is kept current by chat lifecycle events
 *   write — mutations land in the mirror, then `flush()` diffs against the
 *           baseline snapshot and issues the matching RPC calls
 *
 * The diff is what makes ST's "mutate then save" idiom work unchanged.
 *
 * Lumiverse's `ChatMessageDTO` turns out to be very close to SillyTavern's own
 * message shape — `is_user`, `name`, `content`, `send_date`, `swipe_id`,
 * `swipes`, `extra` all line up — so the conversion here is mostly a rename of
 * `content` to `mes`, not a remodel.
 */

import type { ChatMessageDTO } from 'lumiverse-spindle-types'

/** What `spindle.chat.getMessages()` actually resolves to. */
type HostMessage = ChatMessageDTO & {
  role: 'system' | 'user' | 'assistant'
  extra: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/** A SillyTavern chat message as the ported engine expects to see it. */
export interface StMessage {
  name: string
  is_user: boolean
  is_system: boolean
  send_date: number
  mes: string
  swipe_id: number
  swipes: string[]
  extra: Record<string, unknown>
  /** Lumiverse message id. Not present on ST; the compat layer owns it. */
  _lvId?: string
}

/**
 * The API role a shim message should go out as.
 *
 * `extra.type === 'narrator'` is how the engine marks an injection as a
 * framework note rather than a turn somebody took, and SillyTavern's
 * `setOpenAIMessages()` maps it to `system`. Reading only `is_user` /
 * `is_system` — which is what the interceptor shim used to do — sent Dungeon
 * Reality, depth-injected lore and World Progression out as `assistant`, so the
 * model was shown the framework's own notes as though it had written them and
 * then asked to continue from there.
 *
 * The three shapes the engine produces, driven by `loreInjectionRole`:
 *
 * | setting      | is_user | extra.type   | role      |
 * |--------------|---------|--------------|-----------|
 * | 0 (default)  | false   | `'narrator'` | system    |
 * | 1            | true    | —            | user      |
 * | 2            | false   | —            | assistant |
 *
 * Dungeon Reality always uses the first shape.
 */
export function roleForStMessage(
  entry: Partial<StMessage>,
): 'user' | 'system' | 'assistant' {
  if (entry.is_user) return 'user'
  const narrator = (entry.extra as { type?: unknown } | undefined)?.type === 'narrator'
  return entry.is_system || narrator ? 'system' : 'assistant'
}

interface Baseline {
  mes: string
  swipeId: number
  swipes: string
}

const ASSISTANT_FALLBACK_NAME = 'Narrator'
const USER_FALLBACK_NAME = 'You'

function toSt(message: HostMessage): StMessage {
  const swipes = Array.isArray(message.swipes) && message.swipes.length
    ? [...message.swipes]
    : [message.content ?? '']
  return {
    name: message.name
      || (message.is_user ? USER_FALLBACK_NAME : ASSISTANT_FALLBACK_NAME),
    is_user: !!message.is_user,
    // Lumiverse has no `is_system` column; the normalized `role` carries it.
    is_system: message.role === 'system',
    send_date: Number(message.send_date) || Date.now(),
    mes: message.content ?? '',
    swipe_id: Number(message.swipe_id) || 0,
    swipes,
    extra: { ...(message.extra ?? {}), ...(message.metadata ?? {}) },
    _lvId: message.id,
  }
}

function baselineOf(message: StMessage): Baseline {
  return {
    mes: message.mes ?? '',
    swipeId: Number(message.swipe_id) || 0,
    swipes: JSON.stringify(message.swipes ?? []),
  }
}

export class ChatMirror {
  /** The array handed to the engine as `ctx.chat`. Identity is stable. */
  readonly messages: StMessage[] = []

  private chatId: string | null = null
  private baseline = new Map<string, Baseline>()
  private syncing: Promise<void> | null = null
  private dirty = false

  getChatId(): string | null {
    return this.chatId
  }

  /**
   * Point the mirror at a chat and load its messages. Safe to call repeatedly;
   * concurrent callers share the in-flight fetch.
   */
  async attach(chatId: string | null): Promise<void> {
    if (chatId === this.chatId && !this.dirty) return
    this.chatId = chatId
    await this.refresh()
  }

  /** Re-read the whole chat from the host and rebuild the mirror in place. */
  refresh(): Promise<void> {
    if (this.syncing) return this.syncing
    this.syncing = this.doRefresh().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async doRefresh(): Promise<void> {
    const chatId = this.chatId
    this.messages.length = 0
    this.baseline.clear()
    this.dirty = false
    if (!chatId) return

    let raw: HostMessage[] = []
    try {
      raw = await spindle.chat.getMessages(chatId) as HostMessage[]
    } catch (error) {
      spindle.log.error(`[DnD] chat mirror refresh failed: ${(error as Error).message}`)
      return
    }

    for (const message of raw) {
      const converted = toSt(message)
      this.messages.push(converted)
      this.baseline.set(message.id, baselineOf(converted))
    }
  }

  /** Apply a single host-side message change without a full refetch. */
  applyIncoming(message: HostMessage): void {
    if (!message?.id) return
    const converted = toSt(message)
    const index = this.messages.findIndex(entry => entry._lvId === message.id)
    if (index >= 0) this.messages[index] = converted
    else this.messages.push(converted)
    this.baseline.set(message.id, baselineOf(converted))
  }

  applyDeletion(messageId: string): void {
    const index = this.messages.findIndex(entry => entry._lvId === messageId)
    if (index >= 0) this.messages.splice(index, 1)
    this.baseline.delete(messageId)
  }

  /** Mark the mirror dirty so the next `flush()` inspects it. */
  markDirty(): void {
    this.dirty = true
  }

  /**
   * Push every in-place mutation the engine made back to the host.
   *
   * Messages the engine appended to the array have no `_lvId` and become
   * `appendMessage` calls; messages it removed become `deleteMessage` calls.
   *
   * Hidden state is deliberately not diffed here: Lumiverse keeps it out of the
   * message record (`isMessageHidden` / `setMessageHidden` are separate calls),
   * so mirroring it through `extra.hidden` would write a field the host ignores.
   */
  async flush(): Promise<void> {
    const chatId = this.chatId
    if (!chatId) return

    const seen = new Set<string>()

    for (const message of this.messages) {
      if (!message._lvId) {
        try {
          const { id } = await spindle.chat.appendMessage(chatId, {
            role: message.is_user ? 'user' : message.is_system ? 'system' : 'assistant',
            content: message.mes ?? '',
            metadata: { source: 'multihog_dnd' },
          })
          message._lvId = id
          this.baseline.set(id, baselineOf(message))
          seen.add(id)
        } catch (error) {
          spindle.log.error(`[DnD] append failed: ${(error as Error).message}`)
        }
        continue
      }

      seen.add(message._lvId)
      const before = this.baseline.get(message._lvId)
      const after = baselineOf(message)
      if (before
        && before.mes === after.mes
        && before.swipeId === after.swipeId
        && before.swipes === after.swipes) continue

      const patch: Record<string, unknown> = {}
      if (!before || before.mes !== after.mes) patch.content = message.mes ?? ''
      if (!before || before.swipes !== after.swipes) patch.swipes = message.swipes ?? []
      if (!before || before.swipeId !== after.swipeId) patch.swipe_id = after.swipeId

      try {
        if (Object.keys(patch).length) {
          // Tracker rewrites are maintenance edits: they must not force the
          // host to rebuild chat chunks on every turn.
          patch.skipChunkRebuild = true
          await spindle.chat.updateMessage(chatId, message._lvId, patch)
        }
        this.baseline.set(message._lvId, after)
      } catch (error) {
        spindle.log.error(`[DnD] update failed: ${(error as Error).message}`)
      }
    }

    for (const id of [...this.baseline.keys()]) {
      if (seen.has(id)) continue
      try {
        await spindle.chat.deleteMessage(chatId, id)
      } catch (error) {
        spindle.log.error(`[DnD] delete failed: ${(error as Error).message}`)
      }
      this.baseline.delete(id)
    }

    this.dirty = false
  }
}

export const chatMirror = new ChatMirror()
