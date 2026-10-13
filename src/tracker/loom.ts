/**
 * loom.ts — Lumiverse's Loom summary, where the campaign can use it.
 *
 * Loom is Lumiverse's own summarizer. It keeps a running summary of a chat in
 * the chat's metadata (`loom_summary`), and a preset can include it with the
 * `{{loomSummary}}` macro. Paired with Lumiverse's Message Limit, it is how a
 * long campaign stays inside a context window a model handles well: older
 * messages leave the prompt and the summary stands in for them.
 *
 * It is also exactly the half of upstream's design this port had no home for.
 * Upstream calls a summarizer mandatory — it keeps the arc, while the tracker
 * and the Lorebook Agent keep precise state. Three places now use it:
 *
 *   - **The narrator**, without the user editing their preset. Added only when
 *     older messages have actually been cut from the prompt — while the whole
 *     chat still fits, a summary of it only repeats it — and never when the
 *     preset already includes it.
 *   - **The passes that need the story so far**: the Lorebook Agent, deciding
 *     what is worth recording; World Progression; the Adventure Companion.
 *     Each reads only a handful of recent messages, so without this they know
 *     nothing of what happened before them. The State Tracker does not get it:
 *     it tracks the latest turn, and an arc would only invite it to re-apply
 *     events already in the memo.
 *   - **The tracker panel**, read-only, so what the narrator is told about the
 *     past is visible.
 *
 * What an extension cannot do: change what Loom reads (its runs bypass
 * interceptors) or its settings (there is no API for them).
 */

const METADATA_KEY = 'loom_summary'

/** Chat id → summary ('' when the chat has none). Kept current by host events. */
const cache = new Map<string, string>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function fromMetadata(metadata: unknown): string {
  const value = isRecord(metadata) ? metadata[METADATA_KEY] : null
  return typeof value === 'string' ? value.trim() : ''
}

/** The chat's Loom summary, or '' if it has none. */
export async function getLoomSummary(chatId: string | null | undefined): Promise<string> {
  if (!chatId) return ''
  const known = cache.get(chatId)
  if (known !== undefined) return known
  let summary = ''
  try {
    const { userScope } = await import('../compat/user-context')
    const chat = await spindle.chats.get(chatId, userScope())
    summary = fromMetadata(chat?.metadata)
  } catch (error) {
    // Not knowing is not the same as "none" — don't cache a failure.
    spindle.log.warn(`[DnD] reading the Loom summary failed: ${(error as Error).message}`)
    return ''
  }
  cache.set(chatId, summary)
  return summary
}

/**
 * A chat's metadata changed (`CHAT_CHANGED` carries the updated chat). Loom
 * saves its summary there, so this is how a new one arrives. Returns whether
 * the summary itself changed.
 */
export function noteChatMetadata(chatId: string, metadata: unknown): boolean {
  if (!chatId || !isRecord(metadata)) return false
  const next = fromMetadata(metadata)
  const changed = cache.get(chatId) !== next
  cache.set(chatId, next)
  return changed
}

/** Drop what is known; the next read asks the host. */
export function forgetLoomSummary(chatId: string | null | undefined): void {
  if (chatId) cache.delete(chatId)
}

// ── settings ─────────────────────────────────────────────────────────────────

export type NarratorMode = 'auto' | 'always' | 'off'

export function narratorMode(settings: Record<string, unknown>): NarratorMode {
  const value = settings.loomSummaryMode
  return value === 'always' || value === 'off' ? value : 'auto'
}

export function forPasses(settings: Record<string, unknown>): boolean {
  return settings.loomSummaryForPasses !== false
}

// ── the narrator ─────────────────────────────────────────────────────────────

type PromptMessage = { role: string; content: unknown }

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('\n')
  }
  return ''
}

/** Whether a message's opening words appear anywhere in the prompt. */
function present(text: string, haystack: string): boolean {
  const needle = normalise(text).slice(0, 80)
  return needle.length >= 12 && haystack.includes(needle)
}

/**
 * Whether older messages have been cut from this prompt — by Lumiverse's
 * Message Limit or by the context size.
 *
 * Judged from the chat's opening: if none of its first few messages made it
 * into the prompt, the prompt starts later. A few rather than one, because a
 * greeting can be reworded on the way in (macros, display regex). A chat too
 * short to have been cut never is.
 */
export function historyCut(prompt: PromptMessage[], chat: Array<{ mes?: string; is_system?: boolean }>): boolean {
  const opening = chat.filter(m => !m.is_system && normalise(m.mes ?? '').length >= 12)
  if (opening.length < 4) return false
  const haystack = normalise(prompt.map(m => textOf(m.content)).join('\n'))
  return !opening.slice(0, 4).some(m => present(m.mes ?? '', haystack))
}

/** Whether the prompt already carries the summary — the preset's macro, say. */
export function alreadyIncluded(prompt: PromptMessage[], summary: string): boolean {
  const haystack = normalise(prompt.map(m => textOf(m.content)).join('\n'))
  return present(summary, haystack)
}

export function storyBlock(summary: string): string {
  return '<story_so_far>\n'
    + 'What happened earlier in this story, from Lumiverse’s Loom summary. '
    + 'The conversation continues from here; the tracker state is the authority '
    + 'on anything current.\n\n'
    + `${summary}\n</story_so_far>`
}

/**
 * Decide whether the narrator gets the summary, and where. `hostPrompt` is
 * the prompt as Lumiverse assembled it — the evidence for a cut and for the
 * preset's own macro — and `out` is the outgoing prompt, which the block is
 * placed into: after the leading system messages, so it reads as "previously"
 * right before the conversation picks up.
 */
export async function withStorySoFar<T extends PromptMessage>(
  hostPrompt: PromptMessage[],
  out: T[],
  chatId: string | null,
  chat: Array<{ mes?: string; is_system?: boolean }>,
  settings: Record<string, unknown>,
): Promise<T[]> {
  const mode = narratorMode(settings)
  if (mode === 'off' || !chatId) return out
  const summary = await getLoomSummary(chatId)
  if (!summary) return out
  if (alreadyIncluded(hostPrompt, summary)) return out
  if (mode === 'auto' && !historyCut(hostPrompt, chat)) return out
  const at = out.findIndex(message => message.role !== 'system')
  const block = { role: 'system', content: storyBlock(summary) } as T
  const next = [...out]
  next.splice(at < 0 ? next.length : at, 0, block)
  return next
}

// ── the background passes ────────────────────────────────────────────────────

/**
 * Where each pass's prompt reads the recent story, and how to recognise it.
 * The summary goes immediately before that section: the arc, then what just
 * happened. The headings are the engine's own, fixed in code; `loom.ts` in the
 * tests fails if a re-port renames one.
 */
const PASSES: Array<{ name: string; is: RegExp; before: RegExp }> = [
  // Basic and Agent mode both build `## BUDGET STATUS … ## NARRATIVE … ## INSTRUCTION`.
  { name: 'Lorebook Agent', is: /^## BUDGET STATUS[ \t]*$/m, before: /^## NARRATIVE[ \t]*$/m },
  { name: 'World Progression', is: /Write the World Progression report/, before: /^## RECENT NARRATIVE \(Current Scene Context\)/m },
  // Only the Companion's own scopes. The State Tracker writes the same heading
  // — "(Last N messages)", "(Chunk i of n)" — and must never be matched.
  {
    name: 'Adventure Companion',
    is: /^## NARRATIVE HISTORY \((?:All \d+ messages|Last \d+ of \d+ requested messages)\)/m,
    before: /^## NARRATIVE HISTORY \((?:All \d+ messages|Last \d+ of \d+ requested messages)\)/m,
  },
]

const STORY_HEADING = '## STORY SO FAR (Loom summary of earlier events)'

/**
 * Add the summary to a background request if it is one of the passes above.
 * Anything else — the State Tracker, maps, portraits — passes through as is.
 */
export async function withStoryForPass<T extends PromptMessage>(messages: T[]): Promise<T[]> {
  try {
    const index = messages.findIndex(message => {
      const text = textOf(message.content)
      return PASSES.some(pass => pass.is.test(text) && pass.before.test(text))
    })
    if (index < 0) return messages
    const text = textOf(messages[index].content)
    if (text.includes(STORY_HEADING) || typeof messages[index].content !== 'string') return messages

    const [{ getSettings }, { getContext }] = await Promise.all([
      import('../engine/state-manager.js') as Promise<{ getSettings: () => Record<string, unknown> }>,
      import('../compat/context'),
    ])
    if (!forPasses(getSettings())) return messages
    // The pass's own chat — held steady for its length — not whatever the user
    // has opened since.
    const summary = await getLoomSummary(getContext().getCurrentChatId())
    if (!summary) return messages

    const pass = PASSES.find(p => p.is.test(text) && p.before.test(text))!
    const match = pass.before.exec(text)!
    const next = [...messages]
    next[index] = {
      ...messages[index],
      content: `${text.slice(0, match.index)}${STORY_HEADING}\n${summary}\n\n${text.slice(match.index)}`,
    }
    return next
  } catch (error) {
    spindle.log.warn(`[DnD] adding the Loom summary to a pass failed: ${(error as Error).message}`)
    return messages
  }
}
