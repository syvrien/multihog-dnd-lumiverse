/**
 * branching.ts — carrying a campaign into a forked chat, and duplicating one.
 *
 * A campaign is not just the chat. It is the tracker state for that chat, plus
 * a stack of lorebooks named after it, plus relationship values keyed by
 * `Book::UID`. Fork the chat and leave that behind and you get a branch with no
 * character, no lore, and every NPC back at zero — silently, which is the worst
 * part.
 *
 * ## The port inverts upstream's design, and it is better this way
 *
 * Upstream owns the gesture: a "Branch Campaign" button calls SillyTavern's
 * `createBranch()` and then copies the state. Lumiverse has no API for an
 * extension to fork a chat — but it **emits `CHAT_FORKED`** when the user forks
 * one themselves.
 *
 * So forking stays the host's job and carrying the campaign becomes the
 * extension's, which is the right split. It also means this works for forks the
 * user makes through Lumiverse's own UI, which upstream's button never covered.
 *
 * The remapping is the fiddly part and comes across from the engine unchanged:
 * relationship values are keyed by book name, so a clone that renames the books
 * without remapping the keys renders every NPC at 0/0.
 */

interface EngineBits {
  getSettings: () => Record<string, any>
  copyChatStatePartition: (
    settings: unknown,
    oldId: string,
    newId: string,
    newPrefix: string,
    bookRenameMap?: Record<string, string>,
  ) => Record<string, unknown>
  cloneStackToPrefix: (
    currentPrefix: string,
    newPrefix: string,
  ) => Promise<{
    ok: boolean
    cloned: number
    matchingCount: number
    bookRenameMap: Record<string, string>
    createdBookNames: string[]
    errors: string[]
  }>
  effectivePrefix: (chatId: string) => string
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, branchUtils, clone, engineSettings] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/features/chat/branch-campaign-utils.js'),
    import('../engine/src/features/chat/clone-campaign-stack.js'),
    import('../engine/src/state/settings.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    copyChatStatePartition: branchUtils.copyChatStatePartition,
    cloneStackToPrefix: clone.cloneCampaignStackToPrefix,
    effectivePrefix: engineSettings.getEffectiveRouterCampaignPrefix,
  }
  return cached
}

export interface CarryResult {
  ok: boolean
  reason?: string
  /** Books duplicated for the new campaign. */
  cloned: number
  /** Non-fatal problems: a book that could not be copied, and so on. */
  errors: string[]
}

/**
 * Give a forked chat its own copy of the campaign.
 *
 * Idempotent by omission: if the fork already has a state partition, this does
 * nothing. `CHAT_FORKED` and the chat switch that follows it can both land, and
 * copying twice would duplicate the lorebook stack.
 */
export async function carryCampaignToFork(
  sourceChatId: string,
  forkedChatId: string,
): Promise<CarryResult> {
  const from = String(sourceChatId ?? '').trim()
  const to = String(forkedChatId ?? '').trim()
  if (!from || !to) return { ok: false, cloned: 0, errors: [], reason: 'missing chat id' }
  if (from === to) return { ok: false, cloned: 0, errors: [], reason: 'same chat' }

  const bits = await engine()
  const settings = bits.getSettings()

  if (!settings.chatStates?.[from]) {
    // Nothing to carry. Not a failure — the source chat may never have been
    // played with the tracker on.
    return { ok: false, cloned: 0, errors: [], reason: 'the source chat has no campaign state' }
  }
  if (settings.chatStates?.[to]) {
    return { ok: false, cloned: 0, errors: [], reason: 'that fork already has a campaign' }
  }

  const oldPrefix = bits.effectivePrefix(from)
  const newPrefix = bits.effectivePrefix(to)

  let bookRenameMap: Record<string, string> = {}
  let cloned = 0
  const errors: string[] = []

  if (oldPrefix && newPrefix && oldPrefix !== newPrefix) {
    if (spindle.permissions.has('world_books')) {
      const result = await bits.cloneStackToPrefix(oldPrefix, newPrefix)
      bookRenameMap = result.bookRenameMap ?? {}
      cloned = result.cloned ?? 0
      errors.push(...(result.errors ?? []))
    } else {
      errors.push('world_books not granted — the branch shares the original lorebooks')
    }
  }

  try {
    // Even when no books were cloned, the partition copy is what gives the
    // branch its character sheet, quests and inventory.
    bits.copyChatStatePartition(settings, from, to, newPrefix, bookRenameMap)
  } catch (error) {
    return { ok: false, cloned, errors, reason: (error as Error).message }
  }

  return { ok: true, cloned, errors }
}

/**
 * Duplicate the current campaign's lorebooks under a new prefix.
 *
 * For starting a fresh run in a world you have already built. The chat state is
 * deliberately *not* copied: the point is a new campaign in the same setting,
 * not the same campaign twice.
 */
export async function cloneCampaign(
  newPrefix: string,
): Promise<{ ok: boolean; cloned: number; errors: string[]; reason?: string }> {
  const target = String(newPrefix ?? '').trim()
  if (!target) return { ok: false, cloned: 0, errors: [], reason: 'name the new campaign' }
  if (!spindle.permissions.has('world_books')) {
    return { ok: false, cloned: 0, errors: [], reason: 'the world_books permission is not granted' }
  }

  const bits = await engine()
  const { chatMirror } = await import('../compat/chat-mirror')
  const current = bits.effectivePrefix(chatMirror.getChatId() ?? '')
  if (!current) {
    return { ok: false, cloned: 0, errors: [], reason: 'no campaign to clone from' }
  }

  const result = await bits.cloneStackToPrefix(current, target)
  if (!result.ok) {
    return {
      ok: false,
      cloned: result.cloned ?? 0,
      errors: result.errors ?? [],
      // The engine's first error is the specific one — a name collision, an
      // identical prefix — and is more useful than a generic failure.
      reason: result.errors?.[0] ?? 'the clone did not run',
    }
  }
  return { ok: true, cloned: result.cloned ?? 0, errors: result.errors ?? [] }
}
