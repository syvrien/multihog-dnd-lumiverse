/**
 * map-edit.ts — correcting a map, and undoing what changed it.
 *
 * The viewer landed first, and a map you can only look at is a map you can only
 * be annoyed by: the Architect puts a door where there is no door, the Updater
 * decides a sealed passage is open, and there was nothing to do about either.
 *
 * ## Why a document editor rather than a canvas
 *
 * Upstream ships a full graph editor. It is `src/ui/panel/**` — drag handles,
 * marquee selection, jQuery — and it is the part of upstream this port replaces
 * wholesale. What it *validates* with is `map-editor-lib.js`, which is DOM-free
 * and ported here intact. So the port keeps the half that matters — the rules —
 * and puts a text editor in front of it, the same trade the raw memo editor
 * makes. The validator returns a JSON path and a sentence for every problem, so
 * a bad edit is refused at the exact field rather than silently corrupting the
 * graph.
 *
 * ## Validate before normalising, not after
 *
 * The obvious wiring — hand the text to `parseEditableDungeonMapJson` (the
 * engine's own parser for upstream's Raw JSON tab) and validate what comes out
 * — is wrong, and the tests caught it. That parser normalises: an exit pointing
 * at a room that does not exist is *dropped*, a duplicated area id is
 * *reassigned*. Validating afterwards sees a clean document and reports
 * nothing, so the save succeeds and the connection you typed silently is not
 * there.
 *
 * So the raw parsed object is validated first, and only a document that already
 * satisfies the rules is normalised on the way to storage. A wrong edit comes
 * back named rather than quietly discarded.
 *
 * ## What the undo actually covers
 *
 * Two snapshots, and it is worth being exact about which:
 *
 *   - **every save this editor makes**, taken before the write;
 *   - **the state of a map when you open it**, so a change made by a pass
 *     between two visits is recoverable.
 *
 * The second is the one that bites in practice: you open a map, find the
 * Updater has invented a corridor, and want the version you last looked at.
 * What it does *not* do is snapshot every intermediate write a pass makes —
 * those happen inside engine modules through `replaceDungeonMapSection`, in a
 * dozen call sites this port must not hand-edit. Upstream catches them by
 * hanging map snapshots off the memo history's `historyIndex` scrubber, which
 * this port does not have.
 */

const HISTORY_LIMIT = 20

interface EngineBits {
  getSettings: () => Record<string, any>
  getAttachment: (entry: unknown) => { content?: string; siteRoot?: string } | null
  parseDungeonMapDocument: (
    content: string,
    siteFallback?: string,
  ) => { document?: Record<string, any> } | null
  serializeDungeonMapDocument: (document: unknown) => string
  replaceDungeonMapSection: (content: string, body: string) => string
  validateMapEditorDocument: (
    raw: unknown,
    options?: { site?: string; originalDocument?: unknown; linkedGatewayIds?: string[] },
  ) => { valid: boolean; errors: Array<{ code: string; path: string; message: string }>; document: Record<string, any> | null }
  createPortableMapPackage: (
    document: unknown,
    metadata?: Record<string, unknown>,
  ) => Record<string, unknown>
  parsePortableMapPackage: (
    value: unknown,
    options?: { site?: string },
  ) => { ok: boolean; errors: string[]; package: { map: Record<string, any> } | null }
  MAP_EDITOR_ENUMS: Record<string, readonly string[]>
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, reality, editor] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/dungeon-reality.js'),
    import('../engine/map-editor-lib.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    getAttachment: reality.getDungeonMapAttachment,
    parseDungeonMapDocument: reality.parseDungeonMapDocument,
    serializeDungeonMapDocument: reality.serializeDungeonMapDocument,
    replaceDungeonMapSection: reality.replaceDungeonMapSection,
    validateMapEditorDocument: editor.validateMapEditorDocument,
    createPortableMapPackage: editor.createPortableMapPackage,
    parsePortableMapPackage: editor.parsePortableMapPackage,
    MAP_EDITOR_ENUMS: editor.MAP_EDITOR_ENUMS,
  }
  return cached
}

/** Resolve `<book>::<uid>` to the live entry and its book. */
async function locate(id: string): Promise<{
  book: any
  bookName: string
  uid: string
  entry: any
} | null> {
  const [bookName, uid] = String(id ?? '').split('::')
  if (!bookName || !uid) return null
  const { loadWorldInfo } = await import('../compat/world-info')
  const book = await loadWorldInfo(bookName)
  const entry = book?.entries?.[uid as unknown as number]
  if (!entry) return null
  return { book, bookName, uid, entry }
}

function documentFor(
  bits: EngineBits,
  entry: unknown,
  fallback: string,
): Record<string, any> | null {
  const attachment = bits.getAttachment(entry)
  if (!attachment?.content) return null
  return bits.parseDungeonMapDocument(attachment.content, fallback)?.document ?? null
}

/** Where this map's undo stack lives. Per map, not per chat: a map is a place. */
function historyFor(settings: Record<string, any>, id: string): Array<Record<string, any>> {
  if (!settings.mapEditHistory || typeof settings.mapEditHistory !== 'object') {
    settings.mapEditHistory = {}
  }
  if (!Array.isArray(settings.mapEditHistory[id])) settings.mapEditHistory[id] = []
  return settings.mapEditHistory[id]
}

/**
 * Push a snapshot, unless it is identical to the newest one.
 *
 * Opening a map twice with nothing in between must not fill the stack with
 * copies, or the undo list stops being a list of changes.
 */
function pushSnapshot(
  settings: Record<string, any>,
  id: string,
  document: Record<string, any>,
  note: string,
  bits: EngineBits,
): boolean {
  const stack = historyFor(settings, id)
  const text = bits.serializeDungeonMapDocument(document)
  if (stack[0]?.text === text) return false
  stack.unshift({ at: Date.now(), note, text })
  stack.splice(HISTORY_LIMIT)
  return true
}

export interface MapEditDraft {
  ok: boolean
  reason?: string
  site?: string
  /** The document as JSON, which is what gets edited. */
  text?: string
  /** Restore points, newest first. */
  history?: Array<{ at: number; note: string }>
  /** The enum values the validator will accept, so the editor can say so. */
  enums?: Record<string, readonly string[]>
}

/**
 * Open a map for editing.
 *
 * Snapshots what is currently stored, so whatever a pass did since the last
 * visit stays recoverable after the next save overwrites it.
 */
export async function readMapForEdit(id: string): Promise<MapEditDraft> {
  if (!spindle.permissions.has('world_books')) {
    return { ok: false, reason: 'the world_books permission is not granted' }
  }
  const bits = await engine()
  try {
    const found = await locate(id)
    if (!found) return { ok: false, reason: 'that map no longer exists' }

    const parsed = documentFor(bits, found.entry, String(found.entry.comment ?? ''))
    if (!parsed) return { ok: false, reason: 'that entry holds no readable map' }

    const settings = bits.getSettings()
    if (pushSnapshot(settings, id, parsed, 'as found', bits)) {
      const { saveSettings } = await import('../compat/settings-store')
      await saveSettings()
    }

    return {
      ok: true,
      site: String(parsed.site ?? ''),
      text: bits.serializeDungeonMapDocument(parsed),
      history: historyFor(settings, id).map(entry => ({
        at: Number(entry.at), note: String(entry.note),
      })),
      enums: bits.MAP_EDITOR_ENUMS,
    }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

export interface MapSaveResult {
  ok: boolean
  reason?: string
  /** One line per problem, each naming the field it is about. */
  errors?: string[]
  history?: Array<{ at: number; note: string }>
}

/** Model replies and pasted text often arrive fenced. */
function stripFence(text: string): string {
  return String(text ?? '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

/**
 * Validate and store an edited map.
 *
 * `validateMapEditorDocument` runs against the *raw* parsed object — see the
 * header. It is the gate that knows about dangling exits, duplicate ids, assets
 * in impossible containers, and the fields the runtime owns.
 */
export async function saveMapEdit(id: string, text: string): Promise<MapSaveResult> {
  if (!spindle.permissions.has('world_books')) {
    return { ok: false, reason: 'the world_books permission is not granted' }
  }
  const bits = await engine()
  try {
    const found = await locate(id)
    if (!found) return { ok: false, reason: 'that map no longer exists' }

    const original = documentFor(bits, found.entry, String(found.entry.comment ?? ''))
    if (!original) return { ok: false, reason: 'that entry holds no readable map' }

    const site = String(original.site ?? found.entry.comment ?? '')

    const source = stripFence(text)
    if (!source.startsWith('{')) {
      return {
        ok: false,
        reason: 'the map must be one JSON object',
        errors: ['$: expected text starting with {'],
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(source)
    } catch (error) {
      return {
        ok: false,
        reason: 'the map JSON could not be parsed',
        errors: [`$: ${(error as Error).message}`],
      }
    }

    const checked = bits.validateMapEditorDocument(raw, {
      site,
      // The validator refuses edits to fields the runtime owns — host identity,
      // linked gateways — and it can only tell by comparing with what is stored.
      originalDocument: original,
    })
    if (!checked.valid || !checked.document) {
      return {
        ok: false,
        reason: `${checked.errors.length} problem(s) with the map`,
        errors: checked.errors.map(problem => `${problem.path}: ${problem.message}`),
      }
    }

    const settings = bits.getSettings()
    pushSnapshot(settings, id, original, 'before an edit', bits)

    found.entry.content = bits.replaceDungeonMapSection(
      String(found.entry.content ?? ''),
      bits.serializeDungeonMapDocument(checked.document),
    )
    const { saveWorldInfo } = await import('../compat/world-info')
    await saveWorldInfo(found.bookName, found.book)

    const { saveSettings } = await import('../compat/settings-store')
    await saveSettings()

    return {
      ok: true,
      history: historyFor(settings, id).map(entry => ({
        at: Number(entry.at), note: String(entry.note),
      })),
    }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * Put back a snapshot.
 *
 * Restoring is itself a change, so the current document is snapshotted first —
 * undoing an undo has to be possible or the button is a trap.
 */
export async function restoreMapSnapshot(id: string, index: number): Promise<MapSaveResult> {
  if (!spindle.permissions.has('world_books')) {
    return { ok: false, reason: 'the world_books permission is not granted' }
  }
  const bits = await engine()
  try {
    const settings = bits.getSettings()
    const stack = historyFor(settings, id)
    const wanted = stack[index]
    if (!wanted) return { ok: false, reason: 'that restore point is gone' }

    const found = await locate(id)
    if (!found) return { ok: false, reason: 'that map no longer exists' }

    const current = documentFor(bits, found.entry, String(found.entry.comment ?? ''))
    if (current) pushSnapshot(settings, id, current, 'before a restore', bits)

    found.entry.content = bits.replaceDungeonMapSection(
      String(found.entry.content ?? ''),
      String(wanted.text),
    )
    const { saveWorldInfo } = await import('../compat/world-info')
    await saveWorldInfo(found.bookName, found.book)

    const { saveSettings } = await import('../compat/settings-store')
    await saveSettings()

    return {
      ok: true,
      history: historyFor(settings, id).map(entry => ({
        at: Number(entry.at), note: String(entry.note),
      })),
    }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * A map as a portable package.
 *
 * Host identity and per-asset runtime provenance are stripped by
 * `createPortableMapPackage` — a map lifted out of one campaign must not carry
 * "the party opened this in session four" into another.
 */
export async function exportMap(id: string): Promise<{
  ok: boolean
  reason?: string
  name?: string
  json?: string
}> {
  const bits = await engine()
  try {
    const found = await locate(id)
    if (!found) return { ok: false, reason: 'that map no longer exists' }
    const parsed = documentFor(bits, found.entry, String(found.entry.comment ?? ''))
    if (!parsed) return { ok: false, reason: 'that entry holds no readable map' }

    const pack = bits.createPortableMapPackage(parsed, {
      suggestedName: String(parsed.site ?? ''),
      core: '',
      keywords: [],
    })
    return {
      ok: true,
      name: `${String(parsed.site ?? 'map').replace(/[^\w -]+/g, '').trim() || 'map'}.map.json`,
      json: JSON.stringify(pack, null, 2),
    }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * Replace a map's layout from a package.
 *
 * The site name is forced to the one already stored rather than taken from the
 * file: the entry, its keywords and the campaign's references all key off the
 * existing name, and an import that renamed the place would leave the map
 * pointing at nothing.
 */
export async function importMap(id: string, json: string): Promise<MapSaveResult> {
  if (!spindle.permissions.has('world_books')) {
    return { ok: false, reason: 'the world_books permission is not granted' }
  }
  const bits = await engine()
  try {
    const found = await locate(id)
    if (!found) return { ok: false, reason: 'that map no longer exists' }
    const original = documentFor(bits, found.entry, String(found.entry.comment ?? ''))
    if (!original) return { ok: false, reason: 'that entry holds no readable map' }

    const site = String(original.site ?? found.entry.comment ?? '')
    const parsed = bits.parsePortableMapPackage(String(json ?? ''), { site })
    if (!parsed.ok || !parsed.package) {
      return { ok: false, reason: 'that is not a usable map package', errors: parsed.errors }
    }

    return saveMapEdit(id, bits.serializeDungeonMapDocument(parsed.package.map))
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}
