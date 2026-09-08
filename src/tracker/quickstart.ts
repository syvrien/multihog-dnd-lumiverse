/**
 * quickstart.ts — Instant Action: pick a genre, get a character, start playing.
 *
 * The manual path (roll → review → commit) is better when you care what you are
 * playing. This is the other mood: you want to be in a story in thirty seconds
 * and you do not mind who you turn out to be.
 *
 * Upstream's `quickstart.js` is the orchestration plus a jQuery status line and
 * `bindQuickStartEvents`, wired to the onboarding markup this port replaces —
 * so the sequence is rebuilt here, step for step, over the engine functions it
 * calls. Every one of those is ported and unmodified:
 *
 *   1. apply the narrator configuration
 *   2. pick a class from the genre's archetypes, and a starting level
 *   3. `generateQuickStartCharacter()` — writes the [CHARACTER] sheet
 *   4. `generatePersonaBio()` — prose for the Lorebook Agent
 *   5. `addPlayerCardToLorebookAgent()` — stores it as this chat's PC
 *   6. send the opening message
 *
 * **One upstream step is deliberately dropped.** Upstream then calls
 * `activateSillyTavernPersona()`, which reaches into SillyTavern's
 * `power_user.persona_descriptions` and creates a persona named after the
 * character. Lumiverse owns personas itself and the port has no shim for those
 * globals, so that call would throw. It is also not needed: SillyTavern used
 * the persona name as `{{user}}` in the prompt, whereas here the character's
 * name reaches the narrator through the memo and the Player Card, which steps
 * 3 and 5 have already written. Silently creating an account-level persona for
 * someone who asked for a character would be the wrong trade even if it worked.
 *
 * Three model calls, so it reports progress: on a slow connection the gap
 * between "Creating character" and a playable chat is long enough that silence
 * reads as a hang.
 */

import { inheritConnections } from './connections'

const GENRES = ['fantasy', 'realistic', 'scifi', 'horror'] as const
export type QuickStartGenre = (typeof GENRES)[number]

const GENRE_LABELS: Record<string, string> = {
  fantasy: 'Fantasy',
  realistic: 'Modern',
  scifi: 'Sci-Fi',
  horror: 'Horror',
}

let running = false

/** Upstream uses the CSPRNG here rather than Math.random; kept. */
function secureRandom(): number {
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return buffer[0] / (0xFFFFFFFF + 1)
}

function pickArchetype(list: string[]): string {
  if (!list.length) return 'Fighter'
  return list[Math.floor(secureRandom() * list.length)] || list[0]
}

interface EngineBits {
  getSettings: () => Record<string, any>
  getArchetypesForGenre: (genre: string) => string[]
  generateQuickStartCharacter: (opts: Record<string, unknown>) => Promise<{ charName: string }>
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
  pickGenreCharacterName: (genre: string) => string
  normalizeInstantActionInstructions: (value: string) => string
  buildInstantActionPromptSection: (value: string) => string
  buildInstantActionOpeningMessage: (value: string) => string
  extractInstantActionLevel: (value: string) => number | null
  resolveInstantActionPlayerCardWords: (selection: unknown, custom: unknown) => number
  resolveInstantActionStartingLevel: (opts: Record<string, unknown>) => number | null
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, creator, names, instant] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/character-creator.js'),
    import('../engine/src/state/character-names.js'),
    import('../engine/src/state/instant-action-instructions.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    getArchetypesForGenre: creator.getArchetypesForGenre,
    generateQuickStartCharacter: creator.generateQuickStartCharacter,
    generatePersonaBio: creator.generatePersonaBio,
    addPlayerCardToLorebookAgent: creator.addPlayerCardToLorebookAgent,
    pickGenreCharacterName: names.pickGenreCharacterName,
    normalizeInstantActionInstructions: instant.normalizeInstantActionInstructions,
    buildInstantActionPromptSection: instant.buildInstantActionPromptSection,
    buildInstantActionOpeningMessage: instant.buildInstantActionOpeningMessage,
    extractInstantActionLevel: instant.extractInstantActionLevel,
    resolveInstantActionPlayerCardWords: instant.resolveInstantActionPlayerCardWords,
    resolveInstantActionStartingLevel: instant.resolveInstantActionStartingLevel,
  }
  return cached
}

/**
 * Fold the card's opening scene into the setup text.
 *
 * `buildCharacterGenerationPrompt()` already sends the card's *description* as
 * "CHARACTER CARD CONTEXT" — but SillyTavern's card snippet never included the
 * scenario or the opening message, because those were not on the object it had.
 * Lumiverse carries both, and they are the better answer to the question the
 * generator is actually being asked: not "what is this world" but "what kind of
 * person is about to walk into *this* scene".
 *
 * The user's own setup text stays first and unmodified. This is appended as
 * context, clearly labelled, and only when a card actually has it — a blank
 * scenario must not turn an empty box into a wall of headings.
 */
function withSceneContext(instructions: string): string {
  const own = String(instructions ?? '').trim()
  try {
    const context = (globalThis as { SillyTavern?: { getContext(): any } })
      .SillyTavern?.getContext?.()
    const card = context?.characters?.[context?.characterId]
    if (!card) return own

    const parts: string[] = []
    const scenario = String(card.scenario ?? '').trim()
    const opening = String(card.first_mes ?? '').trim()
    if (scenario) parts.push(`Scenario: ${scenario}`)
    // Trimmed: an opening message can run to several hundred words, and the
    // generator needs the situation, not the prose.
    if (opening) parts.push(`Opening scene: ${opening.slice(0, 600)}`)
    if (!parts.length) return own

    const scene = `The story already in progress:\n${defuseLevels(parts.join('\n\n'))}\n\n`
      + 'Create someone who belongs in it.'
    return own ? `${own}\n\n${scene}` : scene
  } catch {
    // Context is an enrichment; without it the roll is what it was before.
    return own
  }
}

/**
 * Take the numbers off level mentions in borrowed text.
 *
 * `extractInstantActionLevel()` scans the whole instruction string for
 * `level 5` and treats a hit as the character's starting level, overriding the
 * roll. That is right for something the user typed and wrong for a scenario
 * blurb: "a level 5 threat guards the vault" would quietly make the player a
 * level 5 character.
 *
 * Only the appended scene passes through here. The user's own setup keeps every
 * digit, because there a level really is a level.
 */
function defuseLevels(text: string): string {
  return text
    .replace(/\b(level)\s*[:=]?\s*\d{1,2}\b/gi, '$1')
    .replace(/\b(lvl?\.?)\s*[:=]?\s*\d{1,2}\b/gi, '$1')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)([-\s]+level)\b/gi, '$1')
}

/** A name from the genre's pool, for the "roll a name" button. */
export async function rollName(genre: string): Promise<string> {
  const bits = await engine()
  try {
    return bits.pickGenreCharacterName(GENRES.includes(genre as never) ? genre : 'fantasy')
  } catch (error) {
    spindle.log.warn(`[DnD] name roll failed: ${(error as Error).message}`)
    return ''
  }
}

export interface QuickStartOptions {
  genre: string
  /** Blank means the model chooses. */
  name?: string
  /** One-off scenario setup; not persisted into later turns. */
  instructions?: string
  /** Roll the starting level instead of using the configured one. */
  randomLevel?: boolean
  /** Send "Begin the adventure" once the character exists. */
  sendStarter?: boolean
}

export interface QuickStartResult {
  ok: boolean
  reason?: string
  name?: string
  /** What was rolled, for the summary line. */
  detail?: string
  /** Whether the opening turn was actually sent. */
  started?: boolean
}

export function isQuickStartRunning(): boolean {
  return running
}

/**
 * Run the whole Instant Action pipeline.
 *
 * `sendOpening` is how the first turn is sent — the backend passes the same
 * path a CYOA choice takes, so the interceptor, the memo injection and the
 * tracker pass all behave as they would for a typed message.
 */
export async function runQuickStart(
  options: QuickStartOptions,
  sendOpening: (text: string) => Promise<void> | void,
  onStep?: (label: string) => void,
): Promise<QuickStartResult> {
  if (running) return { ok: false, reason: 'Quick Start is already running' }
  if (!spindle.permissions.has('generation')) {
    return { ok: false, reason: 'generation permission not granted' }
  }

  const bits = await engine()
  const settings = bits.getSettings()
  const genre = GENRES.includes(options.genre as never)
    ? options.genre
    : 'fantasy'

  running = true
  try {
    onStep?.('Enabling systems…')
    // Upstream writes the assembled ruleset into SillyTavern's preset here.
    // There is no preset to write to; the interceptor assembles it fresh every
    // generation, so the configuration is already live.
    settings.onboardingGenre = genre
    // Character creation has its own connection, which defaults to following
    // the main one — see `connections.ts`.
    inheritConnections(settings)

    /*
     * Two values, deliberately not one.
     *
     * `instructions` is the user's own setup: it is capped at 1,000 characters,
     * it decides the starting level, and it is echoed into the chat as "Initial
     * Setup:" on the opening turn. Folding the card's scene into it would spend
     * the user's character budget on text they did not write and then read the
     * story back to the narrator that just told it.
     *
     * `creationContext` is the same text plus the card's scene, and goes to the
     * character generator only.
     */
    const instructions = bits.normalizeInstantActionInstructions(options.instructions ?? '')
    const creationContext = bits.normalizeInstantActionInstructions(
      withSceneContext(instructions),
    )
    const requestedName = String(options.name ?? '').trim()

    const className = pickArchetype(bits.getArchetypesForGenre(genre) ?? [])
    const noLevel = settings.onboardingLevel === 'none'
    const level = bits.resolveInstantActionStartingLevel({
      noLevel,
      randomLevel: options.randomLevel === true,
      random: secureRandom,
    })
    const gearTier = settings.onboardingGearTier || 'auto'
    const wordCount = bits.resolveInstantActionPlayerCardWords(
      settings.onboardingPersonaWords || '150',
      settings.onboardingPersonaWordsCustom,
    )

    // A level named in the setup text wins over the rolled one, so the summary
    // has to say which the sheet will actually use.
    const setupLevel = bits.extractInstantActionLevel(instructions)
    const levelDetail = setupLevel != null
      ? `Lv ${setupLevel} (Initial Setup)`
      : (noLevel ? 'no levels' : `Lv ${level}`)
    const detail = [
      GENRE_LABELS[genre] || genre,
      instructions ? 'custom setup' : className,
      requestedName || 'AI-chosen name',
      levelDetail,
    ].join(' · ')

    onStep?.(`Creating character (${detail})…`)
    const { charName } = await bits.generateQuickStartCharacter({
      genre,
      className,
      level,
      gearTier,
      nameVal: requestedName,
      instantActionInstructions: creationContext,
    })

    onStep?.('Writing the Player Card…')
    const bio = await bits.generatePersonaBio(
      charName,
      wordCount,
      bits.buildInstantActionPromptSection(instructions),
    )
    if (!bio) throw new Error('Persona generation returned empty.')

    const stored = await bits.addPlayerCardToLorebookAgent(charName, bio, wordCount)
    if (!stored) throw new Error('Could not add the Player Card — no active chat.')

    const readyDetail = instructions ? 'custom instructions' : className

    // Opt-out rather than opt-in, matching upstream: the point of Instant
    // Action is that the story has already started when it hands back.
    if (options.sendStarter !== false) {
      onStep?.('Starting the adventure…')
      await sendOpening(bits.buildInstantActionOpeningMessage(instructions))
      onStep?.(`Ready — ${charName} (${readyDetail})`)
      return { ok: true, name: charName, detail: readyDetail, started: true }
    }

    onStep?.(`Ready — ${charName} (${readyDetail}). Type your first action.`)
    return { ok: true, name: charName, detail: readyDetail, started: false }
  } catch (error) {
    const reason = (error as Error)?.message || String(error)
    spindle.log.error(`[DnD] Quick Start failed: ${reason}`)
    return { ok: false, reason }
  } finally {
    running = false
  }
}
