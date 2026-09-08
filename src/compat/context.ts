/**
 * context.ts — the object returned by `SillyTavern.getContext()`.
 *
 * This is the whole compatibility surface in one place. Every member here
 * exists because the ported engine calls it; the counts in the comments are
 * the call-site counts measured against the upstream extension, so it is
 * obvious which members carry weight and which are incidental.
 */

import { chatMirror, type StMessage } from './chat-mirror'
import {
  getWorldInfoEntries,
  getWorldInfoNames,
  loadWorldInfo,
  reloadWorldInfoEditor,
  saveWorldInfo,
  updateWorldInfoList,
} from './world-info'
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup-bridge'
import { executeSlashCommandsWithOptions } from './slash'
import {
  ConnectionManagerRequestService,
  generateQuietPrompt,
  generateRaw,
} from './llm'
import { event_types, eventSource } from './events'
import { registerFunctionTool, unregisterFunctionTool } from './tools'
import { extensionSettings, saveSettings, saveSettingsDebounced } from './settings-store'
import { userScope } from './user-context'

const CHAT_METADATA_KEY = 'multihog_dnd_metadata'

/** Mirrors ST's `chat_metadata`; persisted into `spindle.variables.chat`. */
export const chatMetadata: Record<string, unknown> = {}

let activeChatId: string | null = null
let activeCharacterId: number | null = null
let characters: Array<Record<string, unknown>> = []
/** A filter entry that matches no book, meaning "none of them". */
const NO_SUCH_BOOK = '\u0000__multihog_no_book__'
let personaName = 'You'
let characterName = 'Narrator'

export function setActiveChat(chatId: string | null): void {
  activeChatId = chatId
}

export function setActiveCharacter(characterId: number | null, name?: string): void {
  activeCharacterId = characterId
  if (name) characterName = name
}

/**
 * Resolve the chat's character card into the shape the engine reads.
 *
 * Eight call sites across `character-creator.js`, `portraits.js` and
 * `narrative-hooks.js` do `ctx.characters?.[ctx.characterId]`, and every one of
 * them was getting `undefined`: nothing ever called the setters, so the id was
 * `null` and the list was empty. The visible effect was that rolling a
 * character — by Instant Action or by hand — never knew which campaign it was
 * for, and the portrait prompts had no world to describe. Nothing threw; the
 * generated character was simply generic.
 *
 * `characterId` is an **array index** in SillyTavern, not an id, and
 * `narrative-hooks.js` checks `Array.isArray(ctx.characters)` before indexing.
 * So the mapping keeps that shape exactly: a one-element array holding the
 * active card, with the index at 0. The host's real id stays on the card as
 * `id` for anything that wants it.
 */
export async function loadActiveCharacter(chatId: string | null): Promise<void> {
  activeCharacterId = null
  characters = []
  if (!chatId || !spindle.permissions.has('characters')) return

  try {
    const chat = await spindle.chats.get(chatId, userScope())
    const characterId = (chat as { character_id?: string } | null)?.character_id
    if (!characterId) return

    const card = await spindle.characters.get(characterId, userScope())
    if (!card) return

    characters = [{
      // What the engine actually reads.
      name: card.name ?? '',
      description: card.description ?? '',
      avatar: card.image_id ?? '',
      // Carried because Lumiverse has them and SillyTavern's card snippet did
      // not — the opening scene is the best available answer to "what kind of
      // character does this story want?".
      scenario: card.scenario ?? '',
      first_mes: card.first_mes ?? '',
      personality: card.personality ?? '',
      id: card.id,
      // Which world books the card brings with it. Lumiverse activates these
      // for the narrator itself; this is so the tracker can be pointed at the
      // same ones instead of at every book in the account.
      world_book_ids: Array.isArray(card.world_book_ids) ? [...card.world_book_ids] : [],
    }]
    activeCharacterId = 0
    if (card.name) characterName = card.name
    await applyLoreScope()
  } catch (error) {
    // A campaign without a card is ordinary; so is a revoked permission.
    spindle.log.warn(`[DnD] could not resolve the chat's character: ${(error as Error).message}`)
  }
}

export function setCharacters(list: Array<Record<string, unknown>>): void {
  characters = list
}

export function setPersonaName(name: string): void {
  personaName = name || 'You'
}

/**
 * Point the tracker's world-lore context at the right books.
 *
 * `buildLorebookContext()` reads `settings.lorebookFilter` when it is non-empty
 * and **every book in the account** when it is not. On a machine with one
 * campaign those are the same thing; on a machine with six they are very much
 * not, and the difference is paid on every tracker pass.
 *
 * The card already names the books that belong to this story, so "the card's
 * own books" becomes a real option rather than all-or-nothing. The filter is
 * the engine's own mechanism; this only fills it in.
 *
 * `loreScope: 'manual'` leaves `lorebookFilter` alone, for anyone who has
 * curated it by hand.
 */
export async function applyLoreScope(): Promise<void> {
  const { getSettings } = await import('../engine/state-manager.js') as {
    getSettings: () => Record<string, any>
  }
  const settings = getSettings()
  const scope = String(settings.loreScope ?? 'card')
  if (scope === 'manual') return

  if (scope === 'all') {
    /*
     * Named explicitly rather than left empty.
     *
     * An empty filter makes `buildLorebookContext()` fall back to
     * `stCtx.getWorldInfoNames?.()`, which it calls *synchronously* against an
     * async function — it gets a Promise, and the whole block fails into a
     * `catch` that only warns. Filling the filter here, where the call can be
     * awaited, means "every book" actually delivers every book.
     */
    settings.lorebookFilter = await getWorldInfoNames()
    return
  }

  const ids: string[] = (characters[0]?.world_book_ids as string[]) ?? []
  if (!ids.length) {
    // A card with nothing attached is not the same as no card. An empty
    // filter means "every book", which is the opposite of what this scope
    // asked for, so name one that cannot exist rather than widen silently.
    settings.lorebookFilter = characters.length ? [NO_SUCH_BOOK] : []
    return
  }

  const names: string[] = []
  for (const id of ids) {
    try {
      const book = await spindle.world_books.get(id, userScope())
      if (book?.name) names.push(book.name)
    } catch {
      // A deleted book is not worth failing a chat switch over.
    }
  }
  settings.lorebookFilter = names
}

/** Load `chat_metadata` for the active chat out of chat variables. */
export async function loadChatMetadata(chatId: string | null): Promise<void> {
  for (const key of Object.keys(chatMetadata)) delete chatMetadata[key]
  if (!chatId) return
  try {
    const raw = await spindle.variables.chat.get(chatId, CHAT_METADATA_KEY)
    if (!raw) return
    Object.assign(chatMetadata, JSON.parse(raw) as Record<string, unknown>)
  } catch (error) {
    spindle.log.warn(`[DnD] chat metadata load failed: ${(error as Error).message}`)
  }
}

export async function saveChatMetadata(): Promise<void> {
  if (!activeChatId) return
  try {
    await spindle.variables.chat.set(activeChatId, CHAT_METADATA_KEY, JSON.stringify(chatMetadata))
  } catch (error) {
    spindle.log.error(`[DnD] chat metadata save failed: ${(error as Error).message}`)
  }
}

let saveChatTimer: ReturnType<typeof setTimeout> | null = null

async function saveChat(): Promise<void> {
  if (saveChatTimer) {
    clearTimeout(saveChatTimer)
    saveChatTimer = null
  }
  await chatMirror.flush()
  await saveChatMetadata()
}

function saveChatDebounced(): void {
  chatMirror.markDirty()
  if (saveChatTimer) clearTimeout(saveChatTimer)
  saveChatTimer = setTimeout(() => {
    saveChatTimer = null
    void saveChat()
  }, 500)
}

/**
 * ST's macro substitution. Lumiverse resolves the full macro set server-side
 * during prompt assembly, so the port only handles the two identity macros the
 * engine expands itself before that point.
 */
function substituteParams(text: string): string {
  return String(text ?? '')
    .replace(/\{\{user\}\}/gi, personaName)
    .replace(/\{\{char\}\}/gi, characterName)
}

/**
 * ST's `getRequestHeaders()` returns auth headers for SillyTavern's own REST
 * API. Nothing equivalent exists here, and any surviving caller is reaching for
 * a host endpoint that does not exist — fail loudly rather than send a request
 * that will 404.
 */
function getRequestHeaders(): never {
  throw new Error('[DnD] getRequestHeaders() has no Lumiverse equivalent; use a spindle API instead.')
}

export interface StContext {
  chat: StMessage[]
  chatId: string | null
  characterId: number | null
  groupId: string | null
  characters: Array<Record<string, unknown>>
  name1: string
  name2: string
  chat_metadata: Record<string, unknown>
  extensionSettings: Record<string, unknown>
  getCurrentChatId(): string | null
  saveSettings(): Promise<void>
  saveSettingsDebounced(): void
  saveChat(): Promise<void>
  saveChatDebounced(): void
  loadWorldInfo: typeof loadWorldInfo
  saveWorldInfo: typeof saveWorldInfo
  updateWorldInfoList: typeof updateWorldInfoList
  getWorldInfoNames: typeof getWorldInfoNames
  /** ST's newer name for the same listing; the router probes for both. */
  getLorebookList: typeof getWorldInfoNames
  getWorldInfoEntries: typeof getWorldInfoEntries
  reloadWorldInfoEditor: typeof reloadWorldInfoEditor
  callGenericPopup: typeof callGenericPopup
  POPUP_TYPE: typeof POPUP_TYPE
  POPUP_RESULT: typeof POPUP_RESULT
  executeSlashCommandsWithOptions: typeof executeSlashCommandsWithOptions
  generateRaw: typeof generateRaw
  generateQuietPrompt: typeof generateQuietPrompt
  ConnectionManagerRequestService: typeof ConnectionManagerRequestService
  eventSource: typeof eventSource
  event_types: typeof event_types
  substituteParams: typeof substituteParams
  getRequestHeaders: typeof getRequestHeaders
  registerFunctionTool: typeof registerFunctionTool
  unregisterFunctionTool: typeof unregisterFunctionTool
}

const context: StContext = {
  // ── chat (56 call sites) ──────────────────────────────────────────────────
  get chat() { return chatMirror.messages },
  get chatId() { return activeChatId },
  getCurrentChatId: () => activeChatId,
  saveChat,
  saveChatDebounced,
  get chat_metadata() { return chatMetadata },

  // ── characters (22) ───────────────────────────────────────────────────────
  get characterId() { return activeCharacterId },
  get characters() { return characters },
  get groupId() { return null },
  get name1() { return personaName },
  get name2() { return characterName },

  // ── settings (5) ──────────────────────────────────────────────────────────
  extensionSettings,
  saveSettings,
  saveSettingsDebounced,

  // ── world info (135) ──────────────────────────────────────────────────────
  loadWorldInfo,
  saveWorldInfo,
  updateWorldInfoList,
  getWorldInfoNames,
  getLorebookList: getWorldInfoNames,
  getWorldInfoEntries,
  reloadWorldInfoEditor,

  // ── popups (77) ───────────────────────────────────────────────────────────
  callGenericPopup,
  POPUP_TYPE,
  POPUP_RESULT,

  // ── commands (23) ─────────────────────────────────────────────────────────
  executeSlashCommandsWithOptions,

  // ── generation (7) ────────────────────────────────────────────────────────
  generateRaw,
  generateQuietPrompt,
  ConnectionManagerRequestService,

  // ── events (2 direct, 18 event names) ─────────────────────────────────────
  eventSource,
  event_types,

  // ── LLM tools ─────────────────────────────────────────────────────────────
  // Absent, `registerDiceFunctionTool()` returns at its first line and the
  // tool-call half of the RNG never exists.
  registerFunctionTool,
  unregisterFunctionTool,

  // ── misc ──────────────────────────────────────────────────────────────────
  substituteParams,
  getRequestHeaders,
}

export function getContext(): StContext {
  return context
}
