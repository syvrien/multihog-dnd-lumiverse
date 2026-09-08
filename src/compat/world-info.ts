/**
 * world-info.ts — SillyTavern World Info emulation over `spindle.world_books`.
 *
 * The Lorebook Agent (`router.js`) and the map subsystems address lorebooks by
 * *name* and entries by a numeric `uid`, then read/modify a whole book document
 * and hand it back to `saveWorldInfo()`. Lumiverse addresses both by opaque id
 * and expects per-entry CRUD.
 *
 * This module keeps the ST-shaped document as the working format, holds the
 * id mapping alongside it, and turns each `saveWorldInfo()` into the minimal
 * set of create/update/delete calls.
 */

import type {
  WorldBookDTO,
  WorldBookEntryCreateDTO,
  WorldBookEntryDTO,
} from 'lumiverse-spindle-types'
import { userScope } from './user-context'

/** A SillyTavern world info entry as the ported engine expects to see it. */
export interface StWorldInfoEntry {
  uid: number
  key: string[]
  keysecondary: string[]
  comment: string
  content: string
  constant: boolean
  selective: boolean
  disable: boolean
  order: number
  position: number
  probability: number
  useProbability: boolean
  depth: number
  excludeRecursion: boolean
  /** Lumiverse entry id. Absent on entries the engine has just created. */
  _lvId?: string
}

export interface StWorldInfo {
  entries: Record<string, StWorldInfoEntry>
}

interface BookCache {
  book: WorldBookDTO
  /** uid -> Lumiverse entry id, stable for the lifetime of the process. */
  uidToId: Map<number, string>
  /** Snapshot of the last known server state, keyed by Lumiverse entry id. */
  serverState: Map<string, string>
  nextUid: number
}

const ENTRY_PAGE_SIZE = 200

let bookIndex: Map<string, WorldBookDTO> | null = null
const caches = new Map<string, BookCache>()

function entryFingerprint(entry: StWorldInfoEntry): string {
  return JSON.stringify([
    entry.key, entry.keysecondary, entry.comment, entry.content,
    entry.constant, entry.selective, entry.disable,
    entry.order, entry.position, entry.probability, entry.depth,
  ])
}

function toSt(entry: WorldBookEntryDTO, uid: number): StWorldInfoEntry {
  return {
    uid,
    key: Array.isArray(entry.key) ? [...entry.key] : [],
    keysecondary: Array.isArray(entry.keysecondary) ? [...entry.keysecondary] : [],
    comment: entry.comment ?? '',
    content: entry.content ?? '',
    constant: !!entry.constant,
    selective: !!entry.selective,
    disable: !!entry.disabled,
    order: Number(entry.order_value) || 0,
    position: Number(entry.position) || 0,
    probability: Number(entry.probability ?? 100),
    useProbability: Number(entry.probability ?? 100) < 100,
    depth: Number(entry.depth) || 0,
    excludeRecursion: false,
    _lvId: entry.id,
  }
}

function toLumiverse(entry: StWorldInfoEntry): WorldBookEntryCreateDTO {
  return {
    key: entry.key ?? [],
    keysecondary: entry.keysecondary ?? [],
    content: entry.content ?? '',
    comment: entry.comment ?? '',
    constant: !!entry.constant,
    selective: !!entry.selective,
    disabled: !!entry.disable,
    // ST calls this `order`; Lumiverse's column is `order_value`.
    order_value: Number(entry.order) || 0,
    position: Number(entry.position) || 0,
    probability: Number(entry.probability ?? 100),
    depth: Number(entry.depth) || 0,
  }
}

/** Refresh the name -> book index. Maps to ST's `updateWorldInfoList()`. */
export async function updateWorldInfoList(): Promise<void> {
  const index = new Map<string, WorldBookDTO>()
  let offset = 0
  for (;;) {
    const { data, total } = await spindle.world_books.list({ limit: 200, offset, userId: userScope() })
    for (const book of data) index.set(book.name, book)
    offset += data.length
    if (!data.length || offset >= total) break
  }
  bookIndex = index
}

async function ensureIndex(): Promise<Map<string, WorldBookDTO>> {
  if (!bookIndex) await updateWorldInfoList()
  return bookIndex ?? new Map()
}

/**
 * ST's `world_names` / `getWorldInfoNames()`.
 *
 * Stays **async**, and the lazy `ensureIndex()` is load-bearing: books are
 * created through paths that do not all go through `saveWorldInfo`, so the
 * index can be stale, and rebuilding on a cold read is what covers that.
 *
 * `memo-processor.js` calls this synchronously —
 * `booksToLoad = stCtx.getWorldInfoNames?.() ?? []` — and therefore gets a
 * Promise, whose missing `.length` sends it down a retry path that ends in an
 * unhandled throw and an empty world-lore context. Making this synchronous to
 * suit that one caller looked right and quietly broke the map manifest, which
 * relies on the rebuild. The call site is fixed instead: `applyLoreScope()`
 * fills `settings.lorebookFilter`, and `buildLorebookContext()` uses the filter
 * directly when it is non-empty, never reaching the broken branch.
 */
export async function getWorldInfoNames(): Promise<string[]> {
  return [...(await ensureIndex()).keys()]
}

/**
 * Resolve a book name to the host's id.
 *
 * Goes through the index, which `updateWorldInfoList()` pages in full. Callers
 * that reached for `world_books.list()` directly were taking only the first
 * page and silently losing every book past it.
 */
export async function findWorldBook(name: string): Promise<WorldBookDTO | null> {
  return (await ensureIndex()).get(name) ?? null
}

/**
 * Load a book into ST document shape.
 *
 * Returns `null` when the book does not exist, matching ST's behaviour — the
 * router treats `null` as "book not created yet" and creates it on save.
 */
export async function loadWorldInfo(name: string): Promise<StWorldInfo | null> {
  const index = await ensureIndex()
  const book = index.get(name)
  if (!book) return null

  const cache: BookCache = caches.get(name) ?? {
    book,
    uidToId: new Map(),
    serverState: new Map(),
    nextUid: 0,
  }
  cache.book = book
  cache.serverState.clear()

  const idToUid = new Map<string, number>()
  for (const [uid, id] of cache.uidToId) idToUid.set(id, uid)

  const doc: StWorldInfo = { entries: {} }
  let offset = 0
  for (;;) {
    const { data, total } = await spindle.world_books.entries.list(book.id, {
      limit: ENTRY_PAGE_SIZE,
      offset,
      userId: userScope(),
    })
    for (const entry of data) {
      let uid = idToUid.get(entry.id)
      if (uid === undefined) {
        uid = cache.nextUid++
        cache.uidToId.set(uid, entry.id)
      }
      const converted = toSt(entry, uid)
      doc.entries[String(uid)] = converted
      cache.serverState.set(entry.id, entryFingerprint(converted))
    }
    offset += data.length
    if (!data.length || offset >= total) break
  }

  caches.set(name, cache)
  return doc
}

/** ST's `getWorldInfoEntries(name)`. */
export async function getWorldInfoEntries(name: string): Promise<StWorldInfoEntry[]> {
  const doc = await loadWorldInfo(name)
  return doc ? Object.values(doc.entries) : []
}

/**
 * Persist an ST document, creating the book if the engine is saving a name
 * that does not exist yet.
 */
export async function saveWorldInfo(name: string, data: StWorldInfo): Promise<void> {
  const index = await ensureIndex()
  let book = index.get(name)
  if (!book) {
    book = await spindle.world_books.create({ name, description: '' }, userScope())
    index.set(name, book)
  }

  const cache: BookCache = caches.get(name) ?? {
    book,
    uidToId: new Map(),
    serverState: new Map(),
    nextUid: 0,
  }
  cache.book = book

  const survivors = new Set<string>()

  for (const [uidKey, entry] of Object.entries(data?.entries ?? {})) {
    const uid = Number(uidKey)
    if (!entry) continue
    const existingId = entry._lvId ?? cache.uidToId.get(uid)

    if (!existingId) {
      const created = await spindle.world_books.entries.create(book.id, toLumiverse(entry), userScope())
      entry._lvId = created.id
      cache.uidToId.set(uid, created.id)
      cache.serverState.set(created.id, entryFingerprint(entry))
      survivors.add(created.id)
      continue
    }

    survivors.add(existingId)
    const fingerprint = entryFingerprint(entry)
    if (cache.serverState.get(existingId) === fingerprint) continue
    await spindle.world_books.entries.update(existingId, toLumiverse(entry), userScope())
    cache.serverState.set(existingId, fingerprint)
  }

  // Entries the engine dropped from the document are deletions.
  for (const [id] of [...cache.serverState]) {
    if (survivors.has(id)) continue
    await spindle.world_books.entries.delete(id, userScope())
    cache.serverState.delete(id)
    for (const [uid, mappedId] of cache.uidToId) {
      if (mappedId === id) cache.uidToId.delete(uid)
    }
  }

  caches.set(name, cache)
}

/**
 * ST's `reloadWorldInfoEditor()` repaints SillyTavern's own lorebook editor.
 * Lumiverse owns that surface, so the port only invalidates its cache and lets
 * the host refresh itself. 20 call sites reach this; all are display-only.
 */
export function reloadWorldInfoEditor(): void {
  bookIndex = null
}

/** Drop all cached state. Used on chat switch and after external edits. */
export function invalidateWorldInfoCache(): void {
  // Nulling the index is deliberate: the next read rebuilds it from the host,
  // which is what catches books created outside `saveWorldInfo`.
  bookIndex = null
  caches.clear()
}
