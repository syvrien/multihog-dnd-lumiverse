/**
 * map-view.ts — looking at a map the Architect built.
 *
 * The Map Architect has been drawing real maps and storing them in entry
 * metadata on the campaign's Locations lorebook since the maps slice landed,
 * and there has been no way to see one. A map you cannot look at is a map you
 * cannot tell is wrong.
 *
 * `dungeon-map-graph.js` turns a stored map document into SVG. It takes no DOM
 * — the `document` it wants is the *map* document — so it runs on the backend
 * beside `renderer.js`, and the frontend injects the markup the host sanitises.
 *
 * ## Player-facing by default
 *
 * The graph builder takes `playerFacing`, which hides areas the party has not
 * discovered. That is the honest default: the map is the GM's, and rendering
 * the unexplored half of a dungeon into a panel the player is looking at spoils
 * the thing the Architect was asked to build. Revealing it is one toggle, taken
 * deliberately.
 */

interface EngineBits {
  getSettings: () => Record<string, any>
  /**
   * Resolves where the map is actually kept — a `[MAP]` section inside the
   * entry content, or older entries' extension metadata — and hands back the
   * raw document either way.
   */
  getAttachment: (entry: unknown) => { content?: string; siteRoot?: string } | null
  /** Returns `{ document, migrated }`, not the document. */
  parseDungeonMapDocument: (
    content: string,
    siteFallback?: string,
  ) => { document?: Record<string, any> } | null
  buildGraph: (
    mapDocument: unknown,
    options?: { playerFacing?: boolean; currentLocation?: string },
  ) => Record<string, any> | null
  renderSvg: (
    graph: unknown,
    options?: { compact?: boolean; siteRoot?: string },
  ) => string
  renderReadable: (
    mapDocument: unknown,
    options?: { revealAll?: boolean },
  ) => string
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, reality, graph] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/dungeon-reality.js'),
    import('../engine/dungeon-map-graph.js'),
  ]) as any[]
  cached = {
    getSettings: stateManager.getSettings,
    getAttachment: reality.getDungeonMapAttachment,
    parseDungeonMapDocument: reality.parseDungeonMapDocument,
    buildGraph: graph.buildDungeonMapGraph,
    renderSvg: graph.renderDungeonMapGraphSvg,
    renderReadable: graph.renderDungeonMapReadableHtml,
  }
  return cached
}

export interface MapSummary {
  /** `<book>::<uid>`, the same address the records browser uses. */
  id: string
  site: string
  kind: string
  areas: number
  /** How many the party has actually been to. */
  visited: number
}

/** The map document held by a lorebook entry, wherever it is kept. */
function documentFor(bits: EngineBits, entry: unknown, fallback: string): Record<string, any> | null {
  const attachment = bits.getAttachment(entry)
  if (!attachment?.content) return null
  return bits.parseDungeonMapDocument(attachment.content, fallback)?.document ?? null
}

/** Every map stored for this campaign. */
export async function listMaps(): Promise<{ ok: boolean; maps: MapSummary[]; reason?: string }> {
  if (!spindle.permissions.has('world_books')) {
    return { ok: false, maps: [], reason: 'the world_books permission is not granted' }
  }
  const bits = await engine()
  try {
    const router = await import('../engine/router.js') as unknown as {
      getLorebookManifest: (skip?: boolean) => Promise<Array<Record<string, any>>>
    }
    const manifest = await router.getLorebookManifest(true)
    const maps: MapSummary[] = []

    for (const entry of manifest) {
      if (!entry.has_dungeon_map) continue
      // The manifest entry carries `content`, but not the `comment` the
      // attachment resolver reads, so give it both.
      const parsed = documentFor(
        bits, { content: entry.content, comment: entry.label }, String(entry.label ?? ''),
      )
      if (!parsed) continue
      const areas: Array<Record<string, any>> = parsed.areas ?? []
      maps.push({
        id: String(entry.id),
        site: String(parsed.site ?? entry.label ?? 'Unnamed site'),
        kind: String(parsed.kind ?? ''),
        areas: areas.length,
        visited: areas.filter(area => String(area.knowledge) === 'VISITED').length,
      })
    }
    maps.sort((a, b) => a.site.localeCompare(b.site))
    return { ok: true, maps }
  } catch (error) {
    return { ok: false, maps: [], reason: (error as Error).message }
  }
}

export interface RenderedMap {
  ok: boolean
  reason?: string
  site?: string
  /** The graph as SVG. */
  svg?: string
  /** The same map written out as readable HTML — areas, exits, contents. */
  detail?: string
}

/**
 * Render one map.
 *
 * `revealAll` drops the player-facing filter. Off by default: see the header.
 */
export async function renderMap(id: string, revealAll = false): Promise<RenderedMap> {
  const [bookName, uid] = String(id ?? '').split('::')
  if (!bookName || !uid) return { ok: false, reason: 'that map id is malformed' }

  const bits = await engine()
  try {
    const { loadWorldInfo } = await import('../compat/world-info')
    const book = await loadWorldInfo(bookName)
    const entry = book?.entries?.[uid as unknown as number]
    if (!entry) return { ok: false, reason: 'that map no longer exists' }

    const parsed = documentFor(bits, entry, String(entry.comment ?? ''))
    if (!parsed) return { ok: false, reason: 'that entry holds no readable map' }

    const settings = bits.getSettings()
    // The tracker knows where the party is; the graph highlights it.
    const currentLocation = String(
      /\[LOCATION\]([\s\S]*?)\[\/LOCATION\]/i.exec(String(settings.currentMemo ?? ''))?.[1] ?? '',
    ).trim()

    const graph = bits.buildGraph(parsed, { playerFacing: !revealAll, currentLocation })
    if (!graph) return { ok: false, reason: 'the map could not be laid out' }

    return {
      ok: true,
      site: String(parsed.site ?? ''),
      svg: bits.renderSvg(graph, { compact: true, siteRoot: String(parsed.site ?? '') }),
      detail: bits.renderReadable(parsed, { revealAll }),
    }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}
