/**
 * cortex.ts — handing Multihog's tracked state to Lumiverse's Memory Cortex.
 *
 * Upstream's README says a summarizer is **mandatory**, and recommends
 * Summaryception: SillyTavern has no memory of its own, so something has to
 * compress the context or it grows without bound. Lumiverse does not have that
 * hole. It ships a hybrid memory architecture — vectorised chat chunks behind
 * the `{{memories}}` macro, an entity graph with salience scoring, and tiered
 * consolidations — so the summarizer requirement simply does not transfer.
 *
 * What transfers is the *other* half of the pairing. Upstream's design has the
 * summarizer keep a rough arc while the Lorebook Agent keeps precise records,
 * and on this host those two jobs land on the same machinery. Left alone, they
 * duplicate: the Cortex infers "Kestrel seems important" from prose while
 * Multihog already knows Kestrel is in the party, at what standing, and whether
 * she is alive.
 *
 * So this pushes the half Multihog is authoritative about:
 *
 *   - the player character and the party, as `character` entities
 *   - NPCs the Lorebook Agent has written records for, with their facts
 *   - mapped sites, as `location` entities
 *   - relationship standing, as graph edges with real sentiment
 *   - deaths, as a status change rather than a guess from the narration
 *
 * These go in at `confidence: 1` and never `provisional`, because they are not
 * extracted from prose — they are the tracker's own state, which the user can
 * see and edit. That is exactly the thing a salience heuristic cannot be sure
 * of, so it is the thing worth contributing.
 *
 * ## Off by default
 *
 * This writes into the user's *host-level* memory, which outlives the extension
 * and is shared with everything else on Lumiverse. Nothing about installing a
 * tracker implies consent to that, so it is a switch, and the switch says what
 * it does.
 */

const RELATION_SENTIMENT_SCALE = 100

interface EngineBits {
  getSettings: () => Record<string, any>
  getNpcRelationshipMax: (settings: unknown) => number
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const stateManager = await import('../engine/state-manager.js') as any
  cached = {
    getSettings: stateManager.getSettings,
    getNpcRelationshipMax: stateManager.getNpcRelationshipMax,
  }
  return cached
}

export interface CortexAvailability {
  ok: boolean
  reason?: string
  /** Whether the user has switched the sync on. */
  enabled: boolean
}

/**
 * Whether the bridge can run at all.
 *
 * The permission is declared in the manifest but a user can still decline it,
 * and `spindle.memories` is absent on a host that predates the API — so this
 * reports the specific reason rather than failing at the first call.
 */
export async function cortexAvailable(): Promise<CortexAvailability> {
  const bits = await engine()
  const enabled = bits.getSettings().cortexSyncEnabled === true

  if (!spindle.permissions.has('memories')) {
    return { ok: false, enabled, reason: 'the "memories" permission is not granted' }
  }
  if (!(spindle as { memories?: unknown }).memories) {
    return { ok: false, enabled, reason: 'this Lumiverse build has no Memory Cortex API' }
  }
  return { ok: true, enabled }
}

type EntityType = 'character' | 'location' | 'item' | 'faction' | 'concept' | 'event'

interface Candidate {
  name: string
  type: EntityType
  facts: string[]
  /** Set when the tracker knows this one is gone. */
  status?: 'deceased' | 'destroyed'
  /** Normalised -1..1, from the tracked relationship values. */
  sentiment?: number
  relation?: 'ally' | 'enemy' | 'lover' | 'rival'
  valence?: Record<string, number>
}

/** Lines like `Kestrel — a ranger with a bad knee.` inside a memo block. */
function blockBody(memo: string, tag: string): string {
  const match = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[/${tag}\\]`, 'i').exec(memo)
  return match?.[1] ?? ''
}

/**
 * Names out of a memo block, one per non-empty line.
 *
 * Stat lines are skipped: a block lists `Kestrel` and then `HP: 27/34` beneath
 * it, and "HP" starting with a capital was once enough to file a hit point
 * total as a member of the party.
 */
function namesFrom(body: string): Array<{ name: string; detail: string }> {
  const found: Array<{ name: string; detail: string }> = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // `Label: value` is a stat, not a person.
    if (/^[A-Za-z][\w /]*:\s/.test(line)) continue
    const [namePart, ...rest] = line.split(/\s+[—–-]\s+/)
    const name = namePart.replace(/^[-*•]\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
    if (!name || name.length > 60) continue
    found.push({ name, detail: rest.join(' — ').trim() })
  }
  return found
}

/** Turn tracked standing into an edge the graph can hold. */
function relationFor(
  friendship: number,
  affection: number,
  max: number,
): { relation: Candidate['relation']; sentiment: number } | null {
  if (!max) return null
  const f = friendship / max
  const a = affection / max
  // Ordered by how much they say: love beats liking, hostility beats coolness.
  if (a >= 0.6) return { relation: 'lover', sentiment: Math.max(a, f) }
  if (f <= -0.2) return { relation: 'enemy', sentiment: f }
  if (f >= 0.4) return { relation: 'ally', sentiment: f }
  if (f < 0) return { relation: 'rival', sentiment: f }
  // Between "we have met" and "we are something" there is no edge worth
  // asserting — the entity still goes in, with no relation attached.
  return null
}

/**
 * Everything Multihog is authoritative about, as graph candidates.
 *
 * Deliberately narrow. The Cortex is already reading the prose; contributing a
 * second opinion on what the prose said would be noise. What it cannot get from
 * prose is the tracker's structured state, so that is all this sends.
 */
export async function collectCandidates(): Promise<Candidate[]> {
  const bits = await engine()
  const settings = bits.getSettings()
  const memo = String(settings.currentMemo ?? '')
  const found = new Map<string, Candidate>()

  const add = (candidate: Candidate): void => {
    const key = candidate.name.toLowerCase()
    const existing = found.get(key)
    if (!existing) { found.set(key, candidate); return }
    // Merge rather than overwrite: an NPC can be in the party *and* have a
    // lorebook record, and the record's facts are the better half.
    existing.facts = [...new Set([...existing.facts, ...candidate.facts])]
    existing.status ??= candidate.status
    existing.relation ??= candidate.relation
    existing.sentiment ??= candidate.sentiment
    existing.valence ??= candidate.valence
  }

  // The player character.
  const character = blockBody(memo, 'CHARACTER')
  const pcName = namesFrom(character)[0]?.name
  if (pcName) {
    add({ name: pcName, type: 'character', facts: ['The player character.'] })
  }

  // The party, and anyone benched.
  for (const tag of ['PARTY', 'BENCHED PARTY']) {
    for (const { name, detail } of namesFrom(blockBody(memo, tag))) {
      add({
        name,
        type: 'character',
        facts: [
          tag === 'PARTY' ? 'Travels with the party.' : 'Away from the party.',
          ...(detail ? [detail] : []),
        ],
      })
    }
  }

  // Relationship standing, which the Cortex has no way to measure.
  const max = bits.getNpcRelationshipMax(settings) || 0
  const values = (settings.npcRelationshipValues ?? {}) as Record<string, any>
  for (const [id, value] of Object.entries(values)) {
    // Keys are `book::uid`; the label after the separator is the NPC's name.
    const name = String(id.split('::')[1] ?? '').trim()
    if (!name) continue
    const friendship = Number(value?.friendship ?? 0)
    const affection = Number(value?.affection ?? 0)
    const edge = relationFor(friendship, affection, max)
    add({
      name,
      type: 'character',
      facts: [],
      ...(edge ? { relation: edge.relation, sentiment: edge.sentiment } : {}),
      valence: {
        friendship: max ? friendship / max : 0,
        affection: max ? affection / max : 0,
      },
    })
  }

  // Mapped sites. The Architect only maps somewhere the story actually went.
  for (const site of Object.keys(settings.mapEvolutionLastFiredBySite ?? {})) {
    const name = String(site).trim()
    if (name) add({ name, type: 'location', facts: ['A mapped site in this campaign.'] })
  }

  return [...found.values()]
}

export interface SyncResult {
  ok: boolean
  reason?: string
  entities: number
  relations: number
  /** Names that could not be filed, with why. */
  skipped: string[]
}

/**
 * Push the current state into the Cortex.
 *
 * Upserts rather than replaces: the Cortex owns its graph and has its own
 * salience, mention counts and provenance for these entities. Overwriting that
 * with a tracker snapshot would throw away the half it is better at.
 */
export async function syncToCortex(userId?: string): Promise<SyncResult> {
  const availability = await cortexAvailable()
  if (!availability.ok) {
    return { ok: false, reason: availability.reason, entities: 0, relations: 0, skipped: [] }
  }

  const chatId = (await import('../compat/chat-mirror')).chatMirror.getChatId()
  if (!chatId) {
    return { ok: false, reason: 'no active chat', entities: 0, relations: 0, skipped: [] }
  }

  const bits = await engine()
  const settings = bits.getSettings()
  const pcName = namesFrom(blockBody(String(settings.currentMemo ?? ''), 'CHARACTER'))[0]?.name

  const candidates = await collectCandidates()
  if (!candidates.length) {
    return { ok: true, reason: 'nothing tracked yet', entities: 0, relations: 0, skipped: [] }
  }

  const memories = (spindle as any).memories
  const skipped: string[] = []
  const ids = new Map<string, string>()
  let entities = 0
  let relations = 0

  for (const candidate of candidates) {
    try {
      const entity = await memories.entities.upsert(chatId, {
        name: candidate.name,
        type: candidate.type,
        // Not extracted from prose — the tracker's own state, which the user
        // can see and correct. Nothing provisional about it.
        confidence: 1,
        provisional: false,
      }, { userId })
      if (!entity?.id) { skipped.push(`${candidate.name}: no id returned`); continue }
      ids.set(candidate.name.toLowerCase(), entity.id)
      entities++

      if (candidate.facts.length) {
        await memories.entities.addFacts(entity.id, candidate.facts, userId)
      }
      if (candidate.valence) {
        await memories.entities.updateEmotionalValence(entity.id, candidate.valence, userId)
      }
      if (candidate.status) {
        await memories.entities.updateStatus(
          entity.id, { status: candidate.status, statusChangedAt: Date.now() }, userId,
        )
      }
    } catch (error) {
      // One bad name must not lose the rest of the campaign.
      skipped.push(`${candidate.name}: ${(error as Error).message}`)
    }
  }

  // Relations need both endpoints to exist, so they go in a second pass — the
  // API drops an edge silently when an endpoint is missing.
  if (pcName && ids.has(pcName.toLowerCase())) {
    for (const candidate of candidates) {
      if (!candidate.relation || candidate.name.toLowerCase() === pcName.toLowerCase()) continue
      if (!ids.has(candidate.name.toLowerCase())) continue
      try {
        const edge = await memories.relations.upsert(chatId, {
          source: ids.get(pcName.toLowerCase()),
          target: ids.get(candidate.name.toLowerCase()),
          type: candidate.relation,
          label: `Tracked standing: ${candidate.relation}`,
          sentiment: Math.max(-1, Math.min(1, candidate.sentiment ?? 0)),
        }, { userId })
        if (edge) relations++
      } catch (error) {
        skipped.push(`${candidate.name} relation: ${(error as Error).message}`)
      }
    }
  }

  // The retrieval cache is keyed per chat and lives ~5 minutes; leaving it
  // would have the next generation read memories from before this sync.
  try {
    await memories.cortex.invalidateCache(chatId)
  } catch {
    // Best effort — a stale cache expires on its own.
  }

  return { ok: true, entities, relations, skipped }
}

export interface CortexView {
  ok: boolean
  reason?: string
  enabled: boolean
  /** What the host's memory currently holds for this chat. */
  entities: Array<{ name: string; type: string; status: string; salience: number; facts: number }>
  relations: Array<{ label: string; type: string; sentiment: number }>
  /** Narrative arcs the host has consolidated, newest first. */
  arcs: Array<{ tier: number; summary: string }>
  /** What Multihog would contribute, so the overlap is visible before syncing. */
  candidates: Array<{ name: string; type: string; relation?: string }>
}

/**
 * What the host's memory knows, beside what Multihog would add.
 *
 * Shown together on purpose. The two systems overlap by design here, and the
 * useful question is not "what does each hold" but "is the agent re-deriving
 * something the Cortex already has" — which you can only see side by side.
 */
export async function readCortex(userId?: string): Promise<CortexView> {
  const availability = await cortexAvailable()
  const empty: CortexView = {
    ok: false, enabled: availability.enabled, entities: [], relations: [], arcs: [],
    candidates: [],
  }
  if (!availability.ok) return { ...empty, reason: availability.reason }

  const chatId = (await import('../compat/chat-mirror')).chatMirror.getChatId()
  if (!chatId) return { ...empty, reason: 'no active chat' }

  const memories = (spindle as any).memories
  const candidates = (await collectCandidates()).map(candidate => ({
    name: candidate.name,
    type: candidate.type,
    ...(candidate.relation ? { relation: candidate.relation } : {}),
  }))

  try {
    const [entityRows, relationRows, arcRows] = await Promise.all([
      memories.entities.list(chatId, { limit: 60, userId }).catch(() => []),
      memories.relations.list(chatId, userId).catch(() => []),
      memories.consolidations.list(chatId, { userId }).catch(() => []),
    ])

    return {
      ok: true,
      enabled: availability.enabled,
      entities: (entityRows ?? []).map((row: any) => ({
        name: String(row.name ?? ''),
        type: String(row.entityType ?? ''),
        status: String(row.status ?? ''),
        salience: Number(row.salienceAvg ?? 0),
        facts: Array.isArray(row.facts) ? row.facts.length : 0,
      })),
      relations: (relationRows ?? []).map((row: any) => ({
        label: String(row.label ?? ''),
        type: String(row.type ?? ''),
        sentiment: Number(row.sentiment ?? 0),
      })),
      arcs: (arcRows ?? []).map((row: any) => ({
        tier: Number(row.tier ?? 0),
        summary: String(row.summary ?? ''),
      })),
      candidates,
    }
  } catch (error) {
    return { ...empty, candidates, reason: (error as Error).message }
  }
}

/** Turn the bridge on or off. Off means nothing is ever written. */
export async function setCortexSync(enabled: boolean): Promise<void> {
  const bits = await engine()
  bits.getSettings().cortexSyncEnabled = !!enabled
  const { saveSettings } = await import('../compat/settings-store')
  await saveSettings()
}

export { RELATION_SENTIMENT_SCALE }
