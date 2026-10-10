/**
 * records.ts — what the Lorebook Agent has actually written.
 *
 * The agent has been building a campaign encyclopedia for however long you have
 * been playing, and until now there was no way to look at it. Entries were
 * visible only as their effect on the story, which makes a wrong one very hard
 * to find and a missing one impossible to notice.
 *
 * Grouped the way the agent files them — people, places, factions, quests,
 * events, world reports — each with how many entries it holds and what they
 * cost. The cost matters: active entries are injected into every prompt, so a
 * bloated NPC book is something you pay for on every turn.
 *
 * Token counts are estimated, not measured. The host does not expose the
 * tokeniser for the user's connection, and a rough number the user can act on
 * beats no number at all — it is labelled as approximate wherever it is shown.
 */

import { getCardListFirstSentence } from '../engine/src/ui/panel/card-synopsis.js'

/** Characters per token. Close enough for English prose to steer decisions by. */
const CHARS_PER_TOKEN = 4

/** Book-name suffix to the group it belongs to, in display order. */
const GROUPS: Array<{ id: string; label: string; match: RegExp }> = [
  { id: 'npc', label: 'People', match: /_NPCs?$/i },
  { id: 'loc', label: 'Places', match: /_Locations?$/i },
  { id: 'fac', label: 'Factions', match: /_Factions?$/i },
  { id: 'quest', label: 'Quests', match: /_Quests?$/i },
  { id: 'event', label: 'Events', match: /_Events?$/i },
  { id: 'world', label: 'World reports', match: /_World$/i },
]

/**
 * The one line shown under an entry in the list.
 *
 * NPC and PC entries are written as labelled fields — `Species:`, `Body:`,
 * `Personality:` — so the first 240 characters of one is a run of headers
 * rather than a description of anybody. `getCardListFirstSentence` (ported from
 * `card-synopsis.js`) pulls the appearance line out and takes its first
 * sentence.
 *
 * Most of a campaign's lorebook is not card-shaped — places, factions, quests
 * and world reports are prose — and the same helper handles those through its
 * own fallback: the first meaningful lines, cut at the first sentence. Still an
 * improvement on 240 raw characters. The truncation below is the last resort,
 * for content with no sentence in it at all.
 */
function previewFor(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  try {
    const sentence = getCardListFirstSentence(content)
    if (sentence) return sentence.slice(0, 240)
  } catch {
    // A malformed card must not cost the whole records list.
  }
  return flat.slice(0, 240)
}

export interface RecordEntry {
  id: string
  label: string
  /** Trimmed for the list; the full text is behind the entry. */
  preview: string
  keys: string[]
  /** Whether it is currently being injected into prompts. */
  active: boolean
  pinned: boolean
  tokens: number
  hasMap: boolean
}

export interface RecordGroup {
  id: string
  label: string
  count: number
  tokens: number
  /** How many are being injected right now. */
  active: number
  entries: RecordEntry[]
}

export interface PlayerCard {
  name: string
  bio: string
  portrait: string
}

/**
 * When the Lorebook Agent files next. It runs every few replies (3 by
 * default), so a short session can have NPCs on the tracker card and nothing in
 * the books yet — which, unexplained, reads as broken rather than "not yet".
 */
export interface AgentSchedule {
  enabled: boolean
  runEvery: number
  /** Replies until the next run, counting the one that triggers it. */
  repliesUntilNext: number | null
}

export interface CampaignRecords {
  ok: boolean
  reason?: string
  agent?: AgentSchedule
  /** The books this campaign owns, derived from the chat unless overridden. */
  prefix: string
  groups: RecordGroup[]
  totalTokens: number
  player: PlayerCard | null
}

interface ManifestEntry {
  id: string
  book: string
  uid: string
  label: string
  keys: string[]
  content: string
  is_active: boolean
  is_pinned: boolean
  has_dungeon_map: boolean
}

const estimateTokens = (text: string): number =>
  Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN)

/** Everything the agent has filed for this campaign. */
export async function readCampaignRecords(): Promise<CampaignRecords> {
  const empty: CampaignRecords = {
    ok: false, prefix: '', groups: [], totalTokens: 0, player: null,
  }
  if (!spindle.permissions.has('world_books')) {
    return { ...empty, reason: 'the world_books permission is not granted' }
  }

  const [stateManager, router] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/router.js'),
  ]) as any[]
  const settings = stateManager.getSettings()

  let manifest: ManifestEntry[]
  try {
    // `skipUpdate` — reading the list must not trigger a write or a probe of
    // every book the user owns just because a panel was opened.
    manifest = await router.getLorebookManifest(true) as ManifestEntry[]
  } catch (error) {
    return { ...empty, reason: (error as Error).message }
  }

  const groups: RecordGroup[] = GROUPS.map(group => ({
    id: group.id, label: group.label, count: 0, tokens: 0, active: 0, entries: [],
  }))
  const byId = new Map(groups.map(group => [group.id, group]))

  let totalTokens = 0
  for (const entry of manifest) {
    const match = GROUPS.find(group => group.match.test(entry.book))
    // A book that matches no known suffix is one the agent did not create —
    // silently folding it into a group would misattribute the user's own lore.
    if (!match) continue
    const group = byId.get(match.id)
    if (!group) continue

    const tokens = estimateTokens(entry.content)
    totalTokens += tokens
    group.count++
    group.tokens += tokens
    if (entry.is_active) group.active++
    group.entries.push({
      id: entry.id,
      label: entry.label,
      preview: previewFor(String(entry.content ?? '')),
      keys: entry.keys ?? [],
      active: !!entry.is_active,
      pinned: !!entry.is_pinned,
      tokens,
      hasMap: !!entry.has_dungeon_map,
    })
  }

  for (const group of groups) {
    // Most recently written first is the wrong guess; alphabetical is what a
    // reference gets read as.
    group.entries.sort((a, b) => a.label.localeCompare(b.label))
  }

  const { chatMirror } = await import('../compat/chat-mirror')
  const chatId = chatMirror.getChatId()
  const stored = chatId ? settings.chatStates?.[chatId]?.playerCharacter : null

  return {
    ok: true,
    agent: await agentSchedule(settings),
    prefix: String(settings.routerCampaignPrefixOverride || chatId || ''),
    groups,
    totalTokens,
    player: stored
      ? {
          name: String(stored.name ?? ''),
          bio: String(stored.bio ?? ''),
          portrait: String(settings.customPortraits?.PC
            ?? settings.customPortraits?.CHARACTER ?? ''),
        }
      : null,
  }
}

async function agentSchedule(settings: Record<string, any>): Promise<AgentSchedule> {
  const runEvery = Math.max(1, Number(settings.routerRunEvery) || 1)
  const enabled = settings.routerEnabled !== false
  let repliesUntilNext: number | null = null
  try {
    const hooks = await import('../engine/narrative-hooks.js') as {
      getRouterSchedulerInternals?: () => { routerAutoTick?: number }
    }
    const tick = Number(hooks.getRouterSchedulerInternals?.().routerAutoTick)
    // The reply that brings the count to `runEvery` is the one that runs it.
    if (Number.isFinite(tick)) repliesUntilNext = Math.max(1, runEvery - tick)
  } catch {
    // The schedule is a courtesy; the records are what matter.
  }
  return { enabled, runEvery, repliesUntilNext }
}

/** The full text of one entry, for reading or checking. */
export async function readRecordEntry(id: string): Promise<{ ok: boolean; content?: string; reason?: string }> {
  const [bookName, uid] = String(id ?? '').split('::')
  if (!bookName || !uid) return { ok: false, reason: 'that entry id is malformed' }
  try {
    const { loadWorldInfo } = await import('../compat/world-info')
    const book = await loadWorldInfo(bookName)
    const entry = book?.entries?.[uid]
    if (!entry) return { ok: false, reason: 'that entry no longer exists' }
    return { ok: true, content: String(entry.content ?? '') }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}
