/**
 * npc-library.ts — reusable NPC cards.
 *
 * The Lorebook Agent's NPC entries belong to one campaign. The library is the
 * other thing: a shelf of characters you keep across campaigns, export to a
 * file, and drop into a new game.
 *
 * `npc-library-lib.js` came across whole and is DOM-free, so this is a thin
 * layer over it: the engine owns the record shape, the name uniquing, the
 * pack format, and the two prompts that put a card into play.
 *
 * ## Where a card comes from
 *
 * Capturing from the campaign is the useful direction — an NPC the agent has
 * been writing for twenty turns is worth keeping, and re-typing them is not.
 * `extractLibraryIdentityContent` strips the campaign-specific relationship
 * lines on the way in, so a card taken from one game does not arrive in the
 * next already resenting a player it has never met.
 */

import { getCardLibraryBlurb } from '../engine/src/ui/panel/card-synopsis.js'

export interface LibraryNpc {
  id: string
  name: string
  keys: string[]
  content: string
  notes: string
  portrait: string
  updatedAt: number
  /**
   * Appearance and personality, pulled out of the card.
   *
   * A stored card is a wall of labelled fields, so a library row showing the
   * raw head of one tells you nothing about who they are. This is what upstream
   * puts beside the portrait.
   */
  blurb: string
}

interface EngineBits {
  getSettings: () => Record<string, any>
  getLibrary: (settings: unknown) => Array<Record<string, any>>
  createRecord: (input: Record<string, unknown>) => Record<string, any>
  upsert: (
    settings: unknown,
    record: Record<string, unknown>,
    options?: { overwriteId?: string },
  ) => Record<string, any>
  remove: (settings: unknown, id: string) => Record<string, any> | null
  findById: (settings: unknown, id: string) => Record<string, any> | null
  uniqueName: (base: string, settings: unknown, excludeId?: string | null) => string
  sanitize: (settings: unknown) => void
  /** Returns the package *object*, not text — the caller serialises it. */
  serialize: (record: Record<string, unknown>, portraitDataUrl?: string) => Record<string, unknown>
  parsePackages: (text: string) => Array<Record<string, any>>
  addToPartyPrompt: (record: Record<string, unknown>) => string
  applyAsPcPrompt: (record: Record<string, unknown>) => string
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, lib] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/npc-library-lib.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    getLibrary: lib.getNpcLibrary,
    createRecord: lib.createLibraryRecord,
    upsert: lib.upsertLibraryNpc,
    remove: lib.removeLibraryNpcRecord,
    findById: lib.findLibraryNpcById,
    uniqueName: lib.uniqueLibraryNpcName,
    sanitize: lib.sanitizeNpcLibraryRecords,
    serialize: lib.serializeNpcPackage,
    parsePackages: lib.parseNpcPackages,
    addToPartyPrompt: lib.buildAddLibraryNpcToPartyPrompt,
    applyAsPcPrompt: lib.buildApplyLibraryCardAsPcPrompt,
  }
  return cached
}

/** Never let one malformed card empty the whole library list. */
function blurbFor(content: string): string {
  try {
    return getCardLibraryBlurb(content)
  } catch {
    return ''
  }
}

const toRow = (record: Record<string, any>, portraits: Record<string, string>): LibraryNpc => ({
  id: String(record.id ?? ''),
  name: String(record.name ?? ''),
  keys: Array.isArray(record.keys) ? record.keys.map(String) : [],
  content: String(record.content ?? ''),
  notes: String(record.notes ?? ''),
  // Cards keep a portrait path; the live portrait map is what the panel can show.
  portrait: String(record.portraitPath || portraits[String(record.name ?? '')] || ''),
  updatedAt: Number(record.updatedAt ?? 0),
  blurb: blurbFor(String(record.content ?? '')),
})

export async function listLibrary(): Promise<LibraryNpc[]> {
  const bits = await engine()
  const settings = bits.getSettings()
  // Drops malformed records a hand-edited settings file may hold.
  bits.sanitize(settings)
  const portraits = settings.customPortraits ?? {}
  return bits.getLibrary(settings)
    .map(record => toRow(record, portraits))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Keep an NPC the campaign already knows.
 *
 * Reads them out of the tracker memo rather than asking the user to retype
 * someone the agent has been describing for twenty turns.
 */
export async function captureFromCampaign(name: string): Promise<{ ok: boolean; reason?: string }> {
  const wanted = String(name ?? '').trim()
  if (!wanted) return { ok: false, reason: 'no name given' }

  const bits = await engine()
  const settings = bits.getSettings()
  const memo = String(settings.currentMemo ?? '')

  // The NPC block lists one entity per paragraph, led by the name.
  const block = /\[NPC\]([\s\S]*?)\[\/NPC\]/i.exec(memo)?.[1] ?? ''
  const found = block
    .split(/\n{2,}/)
    .map(part => part.trim())
    .find(part => part.toLowerCase().startsWith(wanted.toLowerCase()))

  if (!found) {
    return { ok: false, reason: `no NPC called "${wanted}" in the current state` }
  }

  const record = bits.createRecord({
    name: bits.uniqueName(wanted, settings),
    content: found,
    portraitPath: settings.customPortraits?.[wanted] ?? '',
  })
  bits.upsert(settings, record)
  return { ok: true }
}

export async function saveCard(
  input: { id?: string; name: string; content: string; notes: string },
): Promise<{ ok: boolean; reason?: string }> {
  const name = String(input?.name ?? '').trim()
  if (!name) return { ok: false, reason: 'a card needs a name' }

  const bits = await engine()
  const settings = bits.getSettings()
  const record = bits.createRecord({
    id: input.id,
    // Renaming into a name already on the shelf would make one unreachable.
    name: bits.uniqueName(name, settings, input.id ?? null),
    content: input.content,
    notes: input.notes,
  })
  bits.upsert(settings, record, input.id ? { overwriteId: input.id } : undefined)
  return { ok: true }
}

export async function deleteCard(id: string): Promise<{ ok: boolean; reason?: string }> {
  const bits = await engine()
  const removed = bits.remove(bits.getSettings(), String(id ?? ''))
  return removed ? { ok: true } : { ok: false, reason: 'that card no longer exists' }
}

/** The card as a shareable text package. */
export async function exportCard(id: string): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const bits = await engine()
  const record = bits.findById(bits.getSettings(), String(id ?? ''))
  if (!record) return { ok: false, reason: 'that card no longer exists' }
  try {
    // Indented: this is meant to be read, pasted and shared by hand.
    return { ok: true, text: JSON.stringify(bits.serialize(record), null, 2) }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/** Read one or more packages back in. */
export async function importCards(text: string): Promise<{ ok: boolean; added: number; reason?: string }> {
  const bits = await engine()
  const settings = bits.getSettings()
  let packages: Array<Record<string, any>>
  try {
    packages = bits.parsePackages(String(text ?? ''))
  } catch (error) {
    return { ok: false, added: 0, reason: (error as Error).message }
  }
  if (!packages.length) return { ok: false, added: 0, reason: 'no NPC cards found in that text' }

  let added = 0
  for (const entry of packages) {
    const record = entry.record ?? entry
    if (!record?.name) continue
    // Imported names are uniqued so a card never silently replaces one you have.
    bits.upsert(settings, bits.createRecord({
      ...record,
      name: bits.uniqueName(String(record.name), settings),
      id: undefined,
    }))
    added++
  }
  return added ? { ok: true, added } : { ok: false, added: 0, reason: 'nothing usable in that text' }
}

/**
 * Put a card into the current game, as a party member or as the player.
 *
 * Both go through the tracker's own direct-prompt path, so the card arrives as
 * a normal state change rather than by hand-editing the memo.
 */
export async function useCard(
  id: string,
  as: 'party' | 'pc',
): Promise<{ ok: boolean; reason?: string }> {
  const bits = await engine()
  const record = bits.findById(bits.getSettings(), String(id ?? ''))
  if (!record) return { ok: false, reason: 'that card no longer exists' }

  const prompt = as === 'pc' ? bits.applyAsPcPrompt(record) : bits.addToPartyPrompt(record)
  const { sendDirectPrompt } = await import('./direct-prompt')
  const result = await sendDirectPrompt(prompt, { debugSource: 'NpcLibrary' })
  if (!result.ok) return { ok: false, reason: result.reason }
  return result.changed
    ? { ok: true }
    : { ok: false, reason: 'the model replied but nothing changed' }
}
