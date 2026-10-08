/**
 * chat-cleanup.ts — what happens to a campaign when its chat is deleted.
 *
 * Nothing happened. Lumiverse emits `CHAT_DELETED`, the port ignored it, and
 * the deleted chat's tracker state stayed in the settings blob for good: its
 * memo, up to twenty memo snapshots, its quests and relationships — in a blob
 * rewritten in full on every save. Its campaign lorebooks stayed too.
 *
 * Upstream added this in 2026.9 (`deleted-chat-data.js`,
 * `purge-orphaned-lorebooks.js`), wired from `index.js`, which the port
 * replaces. Both modules are ported unchanged; this is their wiring, in
 * upstream's order and with upstream's caution:
 *
 *   - **Verify before removing.** A chat is treated as deleted only when the
 *     host says it no longer exists — and checked again after any question,
 *     since the user can act while a popup is open.
 *   - **Never trust a failed or partial lookup.** The catch-up compares saved
 *     campaigns against the user's whole chat list, so an incomplete list
 *     would make live campaigns look orphaned. It refuses to judge anything
 *     unless the list it read adds up to the host's own total.
 *   - **Lorebooks are a separate, explicit choice.** Only books recorded for
 *     the deleted chat, still present, not claimed by any other saved chat,
 *     and not attached to any character card or persona are offered — and each
 *     is re-checked right before it is deleted.
 *
 * Managed portrait files and file-backed history are upstream's too; neither
 * exists here, so neither is touched.
 */

import { userScope } from '../compat/user-context'

export interface CleanupResult {
  /** The chat still exists, or the inventory could not be trusted. */
  skipped?: string
  /** Saved chat data was removed. */
  removed: string[]
  lorebooksDeleted: string[]
  lorebooksFailed: string[]
}

const empty = (skipped?: string): CleanupResult =>
  ({ skipped, removed: [], lorebooksDeleted: [], lorebooksFailed: [] })

async function engine(): Promise<{
  getSettings: () => Record<string, any>
  storedChatIds: (settings: unknown) => string[]
  removeDeletedChatData: (settings: unknown, chatId: string) => boolean
  orphanedLorebooksForDeletedChat: (
    settings: unknown, chatId: string, names: string[], protectedNames?: string[],
  ) => string[]
  offerOrphanedLorebookPurge: (chatId: string, deps: Record<string, unknown>) => Promise<{
    offered: string[], deleted: string[], failed: string[]
  }>
}> {
  const [stateManager, data, purge] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/src/features/chat/deleted-chat-data.js'),
    import('../engine/src/features/chat/purge-orphaned-lorebooks.js'),
  ]) as any[]
  return {
    getSettings: stateManager.getSettings,
    storedChatIds: data.storedChatIds,
    removeDeletedChatData: data.removeDeletedChatData,
    orphanedLorebooksForDeletedChat: purge.orphanedLorebooksForDeletedChat,
    offerOrphanedLorebookPurge: purge.offerOrphanedLorebookPurge,
  }
}

/** Whether the host still has this chat. A failed lookup counts as "yes". */
async function chatExists(chatId: string): Promise<boolean> {
  try {
    return !!(await spindle.chats.get(chatId, userScope()))
  } catch {
    // Not knowing is not the same as "gone" — never delete on an error.
    return true
  }
}

/**
 * Every chat the user has, or `null` when the list cannot be trusted.
 *
 * Paged to the end, and checked against the host's own total: a short read
 * would make real campaigns look orphaned, so it is treated as no answer.
 */
async function allChatIds(): Promise<Set<string> | null> {
  const ids = new Set<string>()
  let total = -1
  try {
    for (let offset = 0; ; ) {
      const page = await spindle.chats.list({ limit: 200, offset, userId: userScope() })
      total = page.total
      for (const chat of page.data) ids.add(chat.id)
      offset += page.data.length
      if (!page.data.length || offset >= total) break
    }
  } catch (error) {
    spindle.log.warn(`[DnD] could not list chats: ${(error as Error).message}`)
    return null
  }
  return ids.size === total ? ids : null
}

/** Lorebook names as the host has them now — never a cached list. */
async function currentBookNames(): Promise<string[]> {
  const { getWorldInfoNames, updateWorldInfoList } = await import('../compat/world-info')
  await updateWorldInfoList()
  return getWorldInfoNames()
}

/**
 * Books something outside the tracker depends on.
 *
 * Upstream protects SillyTavern's globally selected books. The Lumiverse
 * equivalent is a book attached to a character card or a persona: deleting one
 * of those would break a card the user still has. Conservative by design — if
 * either list cannot be read, every book stays protected.
 */
async function protectedBookNames(): Promise<string[] | null> {
  const ids = new Set<string>()
  try {
    if (spindle.permissions.has('characters')) {
      for (let offset = 0; ; ) {
        const page = await spindle.characters.list({ limit: 200, offset, userId: userScope() })
        for (const card of page.data) for (const id of card.world_book_ids ?? []) ids.add(id)
        offset += page.data.length
        if (!page.data.length || offset >= page.total) break
      }
    }
    if (spindle.permissions.has('personas')) {
      const { data } = await spindle.personas.list({ limit: 200, userId: userScope() })
      for (const persona of data) if (persona.attached_world_book_id) ids.add(persona.attached_world_book_id)
    }
  } catch (error) {
    spindle.log.warn(`[DnD] could not read which books cards use: ${(error as Error).message}`)
    return null
  }
  const { getWorldInfoNames, findWorldBook } = await import('../compat/world-info')
  const names: string[] = []
  for (const name of await getWorldInfoNames()) {
    const book = await findWorldBook(name)
    if (book && ids.has(book.id)) names.push(name)
  }
  return names
}

async function deleteBook(name: string): Promise<boolean> {
  const { findWorldBook, invalidateWorldInfoCache } = await import('../compat/world-info')
  const book = await findWorldBook(name)
  if (!book) return false
  await spindle.world_books.delete(book.id, userScope())
  invalidateWorldInfoCache()
  return true
}

async function confirmPurge(books: string[], intro: string): Promise<boolean> {
  const { callGenericPopup, POPUP_RESULT, POPUP_TYPE } = await import('../compat/popup-bridge')
  const escape = (text: string): string =>
    text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const list = books.map(name => `<li><code>${escape(name)}</code></li>`).join('')
  const answer = await callGenericPopup(
    `<p>${intro}</p><ul>${list}</ul>`
      + '<p>Delete these lorebooks permanently? The campaign data is cleaned up either way.</p>',
    POPUP_TYPE.CONFIRM,
    '',
    { title: 'Delete orphaned lorebooks?', okButton: 'Delete lorebooks', cancelButton: 'Keep lorebooks' },
  )
  return answer === POPUP_RESULT.AFFIRMATIVE
}

/**
 * Clean up after one chat the host has just deleted.
 */
export async function cleanDeletedChat(chatId: string): Promise<CleanupResult> {
  if (!chatId) return empty('no chat id')
  if (await chatExists(chatId)) return empty('the chat still exists')
  const bits = await engine()

  let lore = { offered: [] as string[], deleted: [] as string[], failed: [] as string[] }
  const protectedNames = await protectedBookNames()
  if (protectedNames && spindle.permissions.has('world_books')) {
    try {
      lore = await bits.offerOrphanedLorebookPurge(chatId, {
        getSettings: bits.getSettings,
        getProtectedNames: async () => (await protectedBookNames()) ?? await currentBookNames(),
        listNames: currentBookNames,
        canDelete: async (id: string) => !(await chatExists(id)),
        confirm: async (_id: string, books: string[]) =>
          confirmPurge(books, 'These lorebooks belonged to the chat you deleted, and no other campaign uses them:'),
        deleteBook,
      })
    } catch (error) {
      spindle.log.warn(`[DnD] lorebook cleanup skipped: ${(error as Error).message}`)
    }
  }

  // The user can bring the chat back while the question is open.
  if (await chatExists(chatId)) return { ...empty('the chat came back'), lorebooksDeleted: lore.deleted }
  const removed = bits.removeDeletedChatData(bits.getSettings(), chatId) ? [chatId] : []
  return { removed, lorebooksDeleted: lore.deleted, lorebooksFailed: lore.failed }
}

/**
 * Catch up on chats deleted while nothing was listening — every chat deleted
 * before this existed, for a start. Asks first, as upstream's button does.
 */
export async function cleanOrphanedChats(): Promise<CleanupResult> {
  const bits = await engine()
  const existing = await allChatIds()
  if (!existing) return empty('could not read the full chat list, so nothing was judged orphaned')
  const orphans = bits.storedChatIds(bits.getSettings()).filter(id => !existing.has(id))
  if (!orphans.length) return empty()

  const { callGenericPopup, POPUP_RESULT, POPUP_TYPE } = await import('../compat/popup-bridge')
  const proceed = await callGenericPopup(
    `<p>Found saved campaign data for <b>${orphans.length} chat(s)</b> that no longer exist. `
      + 'Remove their memo, history and other saved state?</p>'
      + '<p>Lorebooks are a separate question, asked next if any are eligible.</p>',
    POPUP_TYPE.CONFIRM,
    '',
    { title: 'Clean up deleted chats?', okButton: `Clean up ${orphans.length}`, cancelButton: 'Cancel' },
  )
  if (proceed !== POPUP_RESULT.AFFIRMATIVE) return empty('cancelled')

  const lorebooksDeleted: string[] = []
  const lorebooksFailed: string[] = []
  const protectedNames = await protectedBookNames()
  if (protectedNames && spindle.permissions.has('world_books')) {
    const names = await currentBookNames()
    const candidates = orphans.flatMap(id =>
      bits.orphanedLorebooksForDeletedChat(bits.getSettings(), id, names, protectedNames)
        .map(name => ({ id, name })))
    if (candidates.length && await confirmPurge(
      candidates.map(c => c.name),
      'These lorebooks belonged to deleted chats, and no other campaign uses them:',
    )) {
      for (const { id, name } of candidates) {
        // Re-checked against fresh state immediately before each deletion.
        const fresh = await currentBookNames()
        const stillProtected = (await protectedBookNames()) ?? fresh
        if (await chatExists(id)) continue
        if (!bits.orphanedLorebooksForDeletedChat(bits.getSettings(), id, fresh, stillProtected).includes(name)) continue
        try {
          if (await deleteBook(name)) lorebooksDeleted.push(name)
          else lorebooksFailed.push(name)
        } catch {
          lorebooksFailed.push(name)
        }
      }
    }
  }

  // Verify again: a chat could have been restored while the questions were open.
  const stillGone = await allChatIds()
  if (!stillGone) return { ...empty('could not re-check the chat list'), lorebooksDeleted, lorebooksFailed }
  const removed = orphans.filter(id => !stillGone.has(id)
    && bits.removeDeletedChatData(bits.getSettings(), id))
  return { removed, lorebooksDeleted, lorebooksFailed }
}
