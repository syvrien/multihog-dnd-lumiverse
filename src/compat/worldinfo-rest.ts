/**
 * worldinfo-rest.ts — serve SillyTavern's world info REST endpoints in-process.
 *
 * 31 call sites across the engine bypass `getContext()` and `fetch()`
 * SillyTavern's REST API directly — 13 of them in `router.js` alone, which is
 * the Lorebook Agent. They exist because SillyTavern keeps an in-memory
 * `worldInfoCache` that goes stale, so the agent reads and writes over HTTP to
 * be sure it sees disk.
 *
 * Rather than rewrite each call site by hand — `src/engine/` is generated, so
 * hand edits would be lost — the port script points every engine `fetch(` at
 * `stFetch` below, which answers the four endpoints against
 * `spindle.world_books`, reusing the same document translation the
 * `getContext()` path uses.
 *
 * The result is that the agent's "authoritative disk read" genuinely is one —
 * Lumiverse has no equivalent stale cache — and the port survives re-running
 * the port script.
 *
 * Anything else under `/api/` still fails loudly by name: those are endpoints
 * with no Lumiverse equivalent, and a silent 404 is how the last three bugs
 * hid.
 */

import {
  findWorldBook,
  getWorldInfoNames,
  invalidateWorldInfoCache,
  loadWorldInfo,
  saveWorldInfo,
  updateWorldInfoList,
  type StWorldInfo,
} from './world-info'
import { userScope } from './user-context'

/** Endpoints this module implements. */
const WORLD_INFO_ROUTE = /^\/api\/worldinfo\/(list|get|edit|delete)$/

/** The extension manual, bundled at port time and served from memory. */
const DOC_ROUTE = /\/docs\/multihogDnDdoc\.md$/

/** Other SillyTavern endpoints, kept as loud failures. */
const ST_ENDPOINT = /^\/api\/(worldinfo|settings|characters|images|avatars|chats|backgrounds)\b/

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function readBody(init?: RequestInit): Promise<Record<string, unknown>> {
  const raw = init?.body
  if (typeof raw !== 'string' || !raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function handleWorldInfo(route: string, init?: RequestInit): Promise<Response> {
  const body = await readBody(init)
  const name = typeof body.name === 'string' ? body.name : ''

  switch (route) {
    case 'list': {
      // SillyTavern answers with `[{ file_id }]`; the agent reads `file_id`.
      //
      // Through the index rather than `world_books.list()` directly: the index
      // is paged in full, whereas the bare call took one page of 200 and the
      // agent simply never saw any book past it.
      await updateWorldInfoList()
      const names = await getWorldInfoNames()
      return json(names.map(name => ({ file_id: name, name })))
    }

    case 'get': {
      if (!name) return json({ error: 'name is required' }, 400)
      const doc = await loadWorldInfo(name)
      // A missing book is a 404, not an empty document: the agent treats a
      // completed response as authoritative, including "not found", and an
      // empty `{entries:{}}` would read as "this book exists but is empty".
      if (!doc) return json({ error: 'not found' }, 404)
      return json(doc)
    }

    case 'edit': {
      if (!name) return json({ error: 'name is required' }, 400)
      const data = body.data as StWorldInfo | undefined
      if (!data || typeof data !== 'object') return json({ error: 'data is required' }, 400)
      await saveWorldInfo(name, data)
      return json({ ok: true })
    }

    case 'delete': {
      if (!name) return json({ error: 'name is required' }, 400)
      // Same reason as `list`: a bare first page would report "not found" for
      // a book that exists, and deleting nothing looks exactly like success.
      const book = await findWorldBook(name)
      if (!book) return json({ error: 'not found' }, 404)
      await spindle.world_books.delete(book.id, userScope())
      invalidateWorldInfoCache()
      return json({ ok: true })
    }

    default:
      return json({ error: 'unsupported' }, 404)
  }
}

/**
 * The engine's `fetch`, as the port runs it. `scripts/port.mjs` rewrites every
 * `fetch(` call in the engine to `stFetch(`.
 *
 * This used to be a replacement for the global `fetch`, installed at startup,
 * with everything it did not recognise passed through to the real one. Newer
 * Lumiverse refuses to install a backend that touches `fetch` at all — a bare
 * call, `globalThis.fetch`, an alias of either — with no opt-in, and its own
 * runtime replaces the global besides. So nothing here is global any more, and
 * nothing reaches the network:
 *
 *   - `/api/worldinfo/{list,get,edit,delete}` are answered in-process, as before
 *   - the extension manual is served from the bundled copy, as before
 *   - other SillyTavern endpoints fail by name, as before
 *   - **any other URL now fails too**, saying why. These are upstream's direct
 *     provider calls — AI Horde, Pollinations, an OpenAI-compatible or Ollama
 *     endpoint — and every one has a Lumiverse replacement the port uses:
 *     image generation through the host, model calls through connections.
 */
export function stFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL ? input.href : (input as Request).url

  const path = /^https?:/i.test(url) ? new URL(url).pathname : url
  const worldInfo = WORLD_INFO_ROUTE.exec(path)

  if (worldInfo && !/^https?:/i.test(url)) {
    if (!spindle.permissions.has('world_books')) {
      return Promise.resolve(json({ error: 'PERMISSION_DENIED:world_books' }, 403))
    }
    return handleWorldInfo(worldInfo[1], init).catch(error => {
      spindle.log.error(`[DnD] world info ${worldInfo[1]} failed: ${(error as Error).message}`)
      return json({ error: (error as Error).message }, 500)
    })
  }

  // The Adventure Companion's tutorial mode fetches the extension manual from
  // its own folder inside SillyTavern. That path does not exist here, and the
  // engine would degrade to "documentation could not be loaded" — leaving the
  // mode with nothing to teach from. The manual is bundled at port time.
  if (DOC_ROUTE.test(path)) {
    return import('../engine/doc-md.js').then(
      ({ ENGINE_DOC }) => new Response(ENGINE_DOC, {
        status: 200,
        headers: { 'Content-Type': 'text/markdown' },
      }),
    )
  }

  if (ST_ENDPOINT.test(path) && !/^https?:/i.test(url)) {
    return Promise.reject(new Error(
      `[DnD] "${path}" is a SillyTavern REST endpoint with no Lumiverse equivalent. `
      + 'Rewrite this call site against the matching spindle API.',
    ))
  }

  return Promise.reject(new Error(
    `[DnD] the extension cannot make network requests in Lumiverse (${url.slice(0, 80)}). `
    + 'Model calls go through Lumiverse connections and images through its image '
    + 'generation: pick a Lumiverse connection for this part of the framework.',
  ))
}
