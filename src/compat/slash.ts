/**
 * slash.ts — SillyTavern `executeSlashCommandsWithOptions()` emulation.
 *
 * Lumiverse has no slash-command grammar, but the engine only ever issues five
 * commands, so this is a small dispatcher rather than a parser:
 *
 *   /world state=on|off silent=true <name>   (15 of 23 call sites)
 *   /profile-list                            list connection profiles
 *   /profile <name>                          switch connection profile
 *   /preset <name>                           switch completion preset
 *   /persona-lock                            not ported — see below
 *
 * Anything else throws with the command echoed, so an unported call site fails
 * loudly at the point of use instead of silently doing nothing.
 */

import { updateWorldInfoList } from './world-info'
import { userScope } from './user-context'

export interface SlashResult {
  /** ST returns the command's output on `.pipe`. */
  pipe: string
}

function stripFlags(rest: string): { flags: Record<string, string>; value: string } {
  const flags: Record<string, string> = {}
  const words: string[] = []
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*)=(.*)$/.exec(token)
    if (match) flags[match[1]] = match[2]
    else words.push(token)
  }
  return { flags, value: words.join(' ').replace(/^["']|["']$/g, '') }
}

async function resolveBookId(name: string): Promise<string | null> {
  let offset = 0
  for (;;) {
    const { data, total } = await spindle.world_books.list({ limit: 200, offset, userId: userScope() })
    const hit = data.find(book => book.name === name)
    if (hit) return hit.id
    offset += data.length
    if (!data.length || offset >= total) return null
  }
}

export async function executeSlashCommandsWithOptions(
  command: string,
  _options: Record<string, unknown> = {},
): Promise<SlashResult> {
  const trimmed = String(command ?? '').trim()
  const match = /^\/([a-zA-Z][a-zA-Z0-9_-]*)\s*([\s\S]*)$/.exec(trimmed)
  if (!match) throw new Error(`[DnD] not a slash command: ${trimmed}`)

  const [, name, rest] = match
  const { flags, value } = stripFlags(rest)

  switch (name) {
    case 'world': {
      // `/world` with no name and state=off means "deactivate everything".
      const state = (flags.state ?? 'on').toLowerCase()
      if (!value) {
        if (state === 'off') await spindle.world_books.setGlobal([], userScope())
        return { pipe: '' }
      }
      const bookId = await resolveBookId(value)
      if (!bookId) {
        spindle.log.warn(`[DnD] /world: no world book named "${value}"`)
        return { pipe: '' }
      }
      const active = await spindle.world_books.getGlobal(userScope())
      const next = state === 'off'
        ? active.filter(id => id !== bookId)
        : active.includes(bookId) ? active : [...active, bookId]
      await spindle.world_books.setGlobal(next, userScope())
      await updateWorldInfoList()
      return { pipe: value }
    }

    case 'profile-list': {
      const connections = await spindle.connections.list(userScope())
      return { pipe: JSON.stringify(connections.map(c => c.name)) }
    }

    case 'profile': {
      const connections = await spindle.connections.list(userScope())
      if (!value) {
        // ST's bare `/profile` reads the current profile name.
        return { pipe: connections[0]?.name ?? '' }
      }
      const hit = connections.find(c => c.name === value)
      if (!hit) {
        spindle.log.warn(`[DnD] /profile: no connection named "${value}"`)
        return { pipe: '' }
      }
      // Lumiverse selects a connection per generation call rather than holding
      // a global "current profile", so the id is handed back for the caller to
      // pass as `connection_id`. See llm.ts.
      return { pipe: hit.id }
    }

    case 'preset': {
      spindle.log.warn('[DnD] /preset is not wired yet — the port selects presets per generation call. See PORTING.md.')
      return { pipe: '' }
    }

    case 'persona-lock': {
      spindle.log.warn('[DnD] /persona-lock is not ported (needs the "personas" permission).')
      return { pipe: '' }
    }

    default:
      throw new Error(`[DnD] unported slash command: ${trimmed}`)
  }
}
