/**
 * player-card.ts — Lorebook Agent Player Cards.
 *
 * "Create PC Card" turns the CHARACTER sheet plus the last few story messages
 * into a prose bio, which is then stored as this chat's player character. The
 * Lorebook Agent loads it whenever the chat opens, so the agent knows who the
 * player is without re-deriving it from the sheet every pass.
 *
 * Upstream flow: `generatePersonaBio()` → a DOM overlay for review →
 * `addPlayerCardToLorebookAgent()`. The two engine functions come across as-is;
 * the overlay is rebuilt on the host's modal in the frontend, because upstream's
 * is hand-built DOM against SillyTavern.
 */

const DEFAULT_WORD_COUNT = 150

/**
 * Tells the generator to follow the existing sheet rather than invent a
 * character, and to use recent messages only for voice and situation.
 */
const EXTRA_HINTS = '\n\nSource: existing [CHARACTER] sheet. Match its stats, '
  + 'class, gear, and traits. Use the last 3 story messages only for voice, '
  + 'relationships, and current situation.'

const PERSONA_OPTIONS = { chatLookback: 3, preferCharacterBlock: true }

export interface PlayerCardDraft {
  ok: boolean
  name: string
  bio: string
  wordCount: number
  reason?: string
}

import { chatMirror } from '../compat/chat-mirror'
import { inheritConnections } from './connections'

interface EngineBits {
  getSettings: () => Record<string, any>
  extractCharNameFromMemo: (memo: string) => string
  generatePersonaBio: (
    charName: string,
    wordCount: number,
    extraHints?: string,
    opts?: Record<string, unknown>,
  ) => Promise<string>
  addPlayerCardToLorebookAgent: (
    name: string,
    bio: string,
    wordCount?: number,
  ) => Promise<boolean>
  saveChatState: (chatId: string) => unknown
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, creator, persistence] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/character-creator.js'),
    import('../engine/src/state/chat-persistence.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    extractCharNameFromMemo: creator.extractCharNameFromMemo,
    generatePersonaBio: creator.generatePersonaBio,
    addPlayerCardToLorebookAgent: creator.addPlayerCardToLorebookAgent,
    saveChatState: persistence.saveChatState,
  }
  return cached
}

/**
 * Strip quotes and backslashes from a name.
 *
 * They would break the lorebook entry the agent builds around it.
 */
function sanitiseName(name: string): string {
  return String(name ?? '').replace(/['"\\]/g, '').trim() || 'My Character'
}

/** How many words the bio should run to, honouring the user's setting. */
function resolveWordCount(settings: Record<string, any>): number {
  const raw = settings.onboardingPersonaWords === 'other'
    ? settings.onboardingPersonaWordsCustom
    : settings.onboardingPersonaWords
  return Number.parseInt(String(raw ?? DEFAULT_WORD_COUNT), 10) || DEFAULT_WORD_COUNT
}

/** Generate a card for review. Nothing is stored until the user approves it. */
export async function generatePlayerCard(): Promise<PlayerCardDraft> {
  const empty = { ok: false, name: '', bio: '', wordCount: DEFAULT_WORD_COUNT }

  if (!spindle.permissions.has('generation')) {
    return { ...empty, reason: 'generation permission not granted' }
  }

  const bits = await engine()
  const settings = bits.getSettings()
  const memo = String(settings.currentMemo ?? '')

  // Upstream refuses rather than inventing a character from nothing.
  if (!/\[CHARACTER\]/i.test(memo)) {
    return { ...empty, reason: 'no [CHARACTER] block in the state memo yet' }
  }

  // Character creation has its own connection, defaulting to SillyTavern's
  // "main API", which does not exist here. See `connections.ts`.
  inheritConnections(settings)

  const name = bits.extractCharNameFromMemo(memo) || 'My Character'
  const wordCount = resolveWordCount(settings)

  let bio = ''
  try {
    bio = await bits.generatePersonaBio(name, wordCount, EXTRA_HINTS, PERSONA_OPTIONS)
  } catch (error) {
    return { ...empty, name, wordCount, reason: (error as Error).message }
  }
  if (!bio?.trim()) {
    return { ...empty, name, wordCount, reason: 'the model returned nothing' }
  }

  return { ok: true, name, bio: bio.trim(), wordCount }
}

/**
 * Store an approved card as this chat's player character.
 *
 * The bio is whatever the user left in the review box, not what the model
 * produced — editing before approving is the point of the review step.
 */
export async function addPlayerCard(
  name: string,
  bio: string,
  wordCount: number,
): Promise<{ ok: boolean; reason?: string }> {
  const finalBio = String(bio ?? '').trim()
  if (!finalBio) return { ok: false, reason: 'the card is empty' }

  const bits = await engine()
  const safeName = sanitiseName(name)

  try {
    const ok = await bits.addPlayerCardToLorebookAgent(
      safeName,
      finalBio,
      wordCount || DEFAULT_WORD_COUNT,
    )
    return ok
      ? { ok: true }
      : { ok: false, reason: 'no active chat to link the player character to' }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/** Genres the character generator knows about, in upstream's order. */
export const CHARACTER_GENRES = [
  'fantasy',
  'scifi',
  'modern',
  'horror',
  'postapoc',
  'historical',
] as const

export interface RollOptions {
  /** An archetype, or `__other__` with `classOther`, or `__story__`. */
  className: string
  /** Free-text class, used when `className` is `__other__`. */
  classOther?: string
  genre?: string
  /** `null` means "no numeric levels" for custom systems. */
  level?: number | null
  gearTier?: string
  name?: string
  /** Seed the sheet from an existing Lumiverse persona, including its image. */
  personaId?: string
}

export interface PersonaChoice {
  id: string
  name: string
  hasImage: boolean
}

/** Sentinel archetypes the prompt builder understands. */
export const CLASS_OTHER = '__other__'
export const CLASS_STORY = '__story__'

/** Personas the user can seed a character from. */
export async function listPersonas(userId?: string): Promise<PersonaChoice[]> {
  if (!spindle.permissions.has('personas')) return []
  try {
    const { data } = await spindle.personas.list({ limit: 100, userId })
    return data.map(persona => ({
      id: persona.id,
      name: persona.name,
      hasImage: !!persona.image_id,
    }))
  } catch (error) {
    spindle.log.warn(`[DnD] persona list failed: ${(error as Error).message}`)
    return []
  }
}

/**
 * Resolve a persona's avatar to a URL the panel can render.
 *
 * This is why seeding from a persona is worth having: it gives the character a
 * portrait without an image-generation provider configured.
 */
async function personaImageUrl(imageId: string | null, userId?: string): Promise<string> {
  if (!imageId || !spindle.permissions.has('images')) return ''
  try {
    const image = await spindle.images.get(imageId, userId)
    return image?.url ?? ''
  } catch (error) {
    spindle.log.warn(`[DnD] persona image lookup failed: ${(error as Error).message}`)
    return ''
  }
}

/** The archetypes offered for a genre, for the roll picker. */
export async function listArchetypes(genre: string): Promise<string[]> {
  const [creator] = await Promise.all([
    import('../engine/character-creator.js'),
  ]) as any[]
  try {
    return creator.getArchetypesForGenre(genre) ?? []
  } catch (error) {
    spindle.log.warn(`[DnD] archetype list failed: ${(error as Error).message}`)
    return []
  }
}

export interface RollDraft {
  ok: boolean
  reason?: string
  /** The name the model gave them. */
  name?: string
  /** The would-be memo. Nothing is written until `commitRoll` is called. */
  memo?: string
  /** The persona's avatar, resolved so the review can show it. */
  portraitUrl?: string
  /** The persona's own name, which is how the portrait gets keyed on commit. */
  personaName?: string
}

/**
 * Roll a brand-new character sheet — for review, not for keeps.
 *
 * The model authors a fresh name, stats, gear and traits, and the result would
 * replace the CHARACTER block. That is a big enough change to show the user
 * first, so this deliberately stops short of writing anything: it returns the
 * sheet and `commitRoll` applies it once approved.
 */
export async function rollCharacter(
  options: RollOptions,
  userId?: string,
): Promise<RollDraft> {
  if (!options?.className) {
    return { ok: false, reason: 'pick a class archetype first' }
  }
  if (options.className === CLASS_OTHER && !options.classOther?.trim()) {
    return { ok: false, reason: 'describe the custom class first' }
  }
  if (!spindle.permissions.has('generation')) {
    return { ok: false, reason: 'generation permission not granted' }
  }

  const bits = await engine()
  const settings = bits.getSettings()

  // Same as the Player Card — see `connections.ts`.
  inheritConnections(settings)

  // Seed from a persona when one was chosen: its name and description steer the
  // sheet, and its avatar becomes the portrait.
  let persona: { name: string; description: string; title: string; imageId: string | null } | null = null
  if (options.personaId) {
    if (!spindle.permissions.has('personas')) {
      return { ok: false, reason: 'personas permission not granted' }
    }
    try {
      const found = await spindle.personas.get(options.personaId, userId)
      if (!found) return { ok: false, reason: 'that persona no longer exists' }
      persona = {
        name: found.name,
        description: found.description ?? '',
        title: found.title ?? '',
        imageId: found.image_id,
      }
    } catch (error) {
      return { ok: false, reason: (error as Error).message }
    }
  }

  const creator = await import('../engine/character-creator.js') as unknown as {
    buildCharacterGenerationPrompt: (opts: Record<string, unknown>) => { prompt: string }
    extractCharNameFromMemo: (memo: string) => string
  }
  const connection = await import('../engine/character-creation-connection.js') as unknown as {
    getCharacterCreationConnectionSettings: (settings: unknown) => Record<string, unknown>
  }

  const { prompt } = creator.buildCharacterGenerationPrompt({
    nameVal: options.name || persona?.name || '',
    genre: options.genre,
    level: options.level,
    gearTier: options.gearTier,
    classRaw: options.className,
    classOtherVal: options.classOther ?? '',
    // The persona's own words describe who this is; the generator turns that
    // into stats rather than inventing a personality from scratch.
    additionalVal: persona
      ? [persona.title, persona.description].filter(Boolean).join('\n\n')
      : '',
  })

  const { sendDirectPrompt } = await import('./direct-prompt')

  const result = await sendDirectPrompt(prompt, {
    systemPromptMode: 'modules_only',
    connectionSettings: connection.getCharacterCreationConnectionSettings(settings),
    rawPrompt: true,
    debugSource: 'CharacterRoll',
    preview: true,
  })
  if (!result.ok) return { ok: false, reason: result.reason }

  const memo = String(result.memo ?? '')
  // The model can reply without authoring a sheet. Offering that for review
  // would invite the user to approve a no-op over their real character.
  if (!result.changed || !/\[CHARACTER\]/i.test(memo)) {
    return { ok: false, reason: 'the model did not return a character sheet' }
  }

  return {
    ok: true,
    name: creator.extractCharNameFromMemo(memo) || persona?.name || 'My Character',
    memo,
    portraitUrl: persona ? await personaImageUrl(persona.imageId, userId) : '',
    personaName: persona?.name,
  }
}

/**
 * Apply a reviewed roll.
 *
 * The memo is whatever the user left in the review box — they can fix a stat
 * the model fumbled without rerolling the whole character. The previous sheet
 * goes into `memoHistory` through the normal commit path.
 */
export async function commitRoll(
  draft: { memo: string; name?: string; portraitUrl?: string; personaName?: string },
): Promise<{ ok: boolean; changed: boolean; portrait: boolean; reason?: string }> {
  const memo = String(draft?.memo ?? '').trim()
  if (!memo) return { ok: false, changed: false, portrait: false, reason: 'the sheet is empty' }

  const { writeMemo } = await import('./direct-prompt')
  const written = await writeMemo(memo)
  if (!written.ok) {
    return { ok: false, changed: false, portrait: false, reason: written.reason }
  }

  const bits = await engine()
  const settings = bits.getSettings()

  let portrait = false
  if (draft.portraitUrl && draft.personaName) {
    // Keyed the way upstream keys it, so both the tracker card and the
    // Lorebook Agent find the same image.
    if (!settings.customPortraits) settings.customPortraits = {}
    const safeName = sanitiseName(draft.personaName)
    const rolledName = draft.name ? sanitiseName(draft.name) : ''
    settings.customPortraits.CHARACTER = draft.portraitUrl
    settings.customPortraits.PC = draft.portraitUrl
    settings.customPortraits[safeName] = draft.portraitUrl
    if (rolledName && rolledName !== safeName) {
      settings.customPortraits[rolledName] = draft.portraitUrl
    }
    portrait = true

    const chatId = chatMirror.getChatId()
    if (chatId) {
      try {
        bits.saveChatState(chatId)
      } catch (error) {
        spindle.log.warn(`[DnD] saving the portrait failed: ${(error as Error).message}`)
      }
    }
  }

  return { ok: true, changed: written.changed, portrait }
}
