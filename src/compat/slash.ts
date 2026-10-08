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
 *   /imagine quiet=true … "<prompt>"         draw, through the host
 *
 * Anything else throws with the command echoed, so an unported call site fails
 * loudly at the point of use instead of silently doing nothing.
 */

import { updateWorldInfoList } from './world-info'
import { userScope } from './user-context'
import { drawImage } from './image-gen'

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

/**
 * The prompt of an `/imagine` command.
 *
 * The engine quotes it and escapes `\` and `"` inside, so it cannot go
 * through `stripFlags`, which splits on whitespace and would also eat any
 * `word=value` in the description as a flag.
 */
function imaginePrompt(rest: string): string {
  const quoted = /"((?:[^"\\]|\\.)*)"\s*$/.exec(rest)
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1')
  return stripFlags(rest).value
}

export async function executeSlashCommandsWithOptions(
  command: string,
  options: Record<string, unknown> = {},
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

    case 'imagine': {
      // Upstream's "native" image source: SillyTavern's own image extension.
      // Here that is the host's image generation. See `compat/image-gen`.
      const url = await drawImage(imaginePrompt(rest), {
        signal: options.signal as AbortSignal | undefined,
      })
      return { pipe: url }
    }

    default:
      throw new Error(`[DnD] unported slash command: ${trimmed}`)
  }
}

/**
 * The corner of SillyTavern's `SlashCommandParser` the engine builds itself.
 *
 * Only `generatePortraitDirect` does: it checks that `/imagine` is registered,
 * parses one command and executes it, reading the image off `.pipe` and
 * failures off `.isError`. That is all this is. Registering commands is not
 * supported — `narrative-hooks.js` needs `SlashCommand` as well before it tries,
 * and the context deliberately has none.
 */
export class SlashCommandParser {
  static commands: Record<string, unknown> = { imagine: { name: 'imagine' } }

  parse(
    text: string,
    _verifyCommandNames?: unknown,
    _flags?: unknown,
    abortController?: { signal: AbortSignal },
  ): { execute(): Promise<{ pipe: string; isError: boolean; isAborted: boolean; errorMessage?: string }> } {
    const signal = abortController?.signal
    return {
      async execute() {
        try {
          const { pipe } = await executeSlashCommandsWithOptions(text, { signal })
          return { pipe, isError: false, isAborted: !!signal?.aborted }
        } catch (error) {
          if (signal?.aborted) return { pipe: '', isError: false, isAborted: true }
          return { pipe: '', isError: true, isAborted: false, errorMessage: (error as Error).message }
        }
      },
    }
  }
}
