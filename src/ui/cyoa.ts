/**
 * cyoa.ts — clickable choice buttons in narrator messages.
 *
 * The narrator is instructed to end each turn with:
 *
 *     <choices>
 *     <button>1. 🤝 Clasp Tiktik's hand — [Persuasion (untrained) DC 12]</button>
 *     …
 *     </choices>
 *
 * Upstream bound this by scanning `.mes_text` for `<button>` elements, then on
 * click stuffing the text into SillyTavern's `#send_textarea` and clicking
 * `#send_but`. None of that exists here, and Lumiverse has a purpose-built
 * primitive: `registerTagInterceptor` matches the `<choices>` tag, strips it
 * from the rendered output, and hands over the content plus the message id.
 * The buttons are then injected into that message's bubble, where the host
 * replays them across chat virtualisation.
 *
 * Clicking sends the choice as a user turn and starts a generation — done on
 * the backend, which owns `chat_mutation`.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend } from '../shared/protocol'

/** `<button>…</button>` entries inside the choices block. */
const BUTTON_RE = /<button[^>]*>([\s\S]*?)<\/button>/gi

/**
 * Mechanical detail the narrator wraps in square brackets, e.g.
 * `— [Perception (untrained) DC 12]`. Rendered as a distinct chip so the
 * action text stays readable.
 */
const MECHANIC_RE = /\[([^\]]+)\]/g

const CYOA_CSS = `
.dnd-cyoa {
  display: flex; flex-direction: column; gap: 6px;
  margin: 10px 0 2px; container-type: inline-size;
}
.dnd-cyoa__choice {
  display: flex; align-items: flex-start; gap: 8px; width: 100%;
  /* 44px minimum tap target. */
  min-height: 44px; padding: 9px 12px;
  border-radius: 8px; cursor: pointer; text-align: left;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-surface, rgba(128,128,128,.08));
  color: var(--lumiverse-text, inherit);
  font: inherit; line-height: 1.45;
  transition: border-color .12s ease, background .12s ease;
}
.dnd-cyoa__choice:hover:not(:disabled) {
  border-color: var(--lumiverse-primary, rgba(140,110,230,.7));
  background: var(--lumiverse-surface-hover, rgba(140,110,230,.12));
}
.dnd-cyoa__choice:disabled { opacity: .55; cursor: default; }
.dnd-cyoa__index {
  flex: 0 0 auto; opacity: .6; font-variant-numeric: tabular-nums;
}
.dnd-cyoa__text { flex: 1 1 auto; overflow-wrap: anywhere; }
.dnd-cyoa__mech {
  display: inline-block; margin-left: 4px; padding: 1px 6px;
  border-radius: 4px; font-size: .88em; white-space: nowrap;
  background: rgba(255,201,102,.14); color: #ffc966;
}
.dnd-cyoa__sent {
  padding: 6px 2px; opacity: .7; font-style: italic;
}
`

interface ParsedChoice {
  /** Text sent to the model — the full original line, mechanics included. */
  raw: string
  /** Leading "1." style index, pulled out for display. */
  index: string
  /** Remaining text with mechanics split out. */
  parts: Array<{ kind: 'text' | 'mech'; value: string }>
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

/** Strip any markup the narrator wrapped around the choice text. */
function toPlainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

export function parseChoices(content: string): ParsedChoice[] {
  const choices: ParsedChoice[] = []
  BUTTON_RE.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = BUTTON_RE.exec(content)) !== null) {
    const raw = toPlainText(match[1])
    if (raw) choices.push(toChoice(raw))
  }

  // `useButtonTags: false` produces bare lines instead of <button> elements.
  if (!choices.length) {
    for (const line of content.split('\n')) {
      const raw = toPlainText(line)
      if (raw) choices.push(toChoice(raw))
    }
  }
  return choices
}

function toChoice(raw: string): ParsedChoice {
  const indexMatch = /^(\d+)[.)]\s*/.exec(raw)
  const index = indexMatch ? indexMatch[1] : ''
  const body = indexMatch ? raw.slice(indexMatch[0].length) : raw

  const parts: ParsedChoice['parts'] = []
  let cursor = 0
  MECHANIC_RE.lastIndex = 0
  let mech: RegExpExecArray | null
  while ((mech = MECHANIC_RE.exec(body)) !== null) {
    if (mech.index > cursor) {
      parts.push({ kind: 'text', value: body.slice(cursor, mech.index) })
    }
    parts.push({ kind: 'mech', value: mech[1] })
    cursor = mech.index + mech[0].length
  }
  if (cursor < body.length) parts.push({ kind: 'text', value: body.slice(cursor) })

  return { raw, index, parts }
}

export interface CyoaHandle {
  dispose(): void
}

export function installCyoa(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): CyoaHandle {
  const removeStyle = ctx.dom.addStyle(CYOA_CSS)
  /** Injected blocks by message id, so re-renders replace rather than stack. */
  const rendered = new Map<string, Element>()

  /**
   * Build the buttons directly into an already-injected wrapper.
   *
   * The wrapper comes from `dom.inject()`, so the host owns its identity and
   * replays it (listeners included) when the bubble remounts. Building into it
   * rather than injecting pre-rendered HTML is what keeps the click handlers
   * alive across scrolling.
   */
  const build = (wrap: Element, choices: ParsedChoice[], messageId: string): void => {
    for (const choice of choices) {
      const button = ctx.dom.createElement('button', {
        class: 'dnd-cyoa__choice',
        type: 'button',
      }) as HTMLButtonElement

      if (choice.index) {
        const index = ctx.dom.createElement('span', { class: 'dnd-cyoa__index' })
        index.textContent = `${choice.index}.`
        button.appendChild(index)
      }

      const text = ctx.dom.createElement('span', { class: 'dnd-cyoa__text' })
      for (const part of choice.parts) {
        if (part.kind === 'text') {
          text.appendChild(document.createTextNode(part.value))
        } else {
          const chip = ctx.dom.createElement('span', { class: 'dnd-cyoa__mech' })
          chip.textContent = part.value
          text.appendChild(chip)
        }
      }
      button.appendChild(text)

      button.addEventListener('click', () => {
        // One choice per turn: disable the whole block immediately so a double
        // click cannot send two user messages into the same generation.
        for (const other of wrap.querySelectorAll('button')) {
          (other as HTMLButtonElement).disabled = true
        }
        const note = ctx.dom.createElement('div', { class: 'dnd-cyoa__sent' })
        note.textContent = 'Sending…'
        wrap.appendChild(note)
        send({ type: 'cyoa:choose', text: choice.raw, messageId })
      })

      wrap.appendChild(button)
    }
  }

  const unsubscribe = ctx.messages.registerTagInterceptor(
    { tagName: 'choices', removeFromMessage: true },
    payload => {
      // Mid-stream the block is incomplete; wait for the closing tag.
      if (payload.isStreaming || payload.isUser) return
      const messageId = payload.messageId
      if (!messageId) return

      const choices = parseChoices(payload.content ?? '')
      if (!choices.length) return

      const target = ctx.dom.findMessageElement(messageId)
      if (!target) return

      const previous = rendered.get(messageId)
      if (previous) {
        ctx.dom.uninject(previous)
        rendered.delete(messageId)
      }

      // Inject an empty wrapper, then build into it. Injections against a
      // bubble are replayed by the host when it remounts, with the wrapper's
      // subtree and listeners intact — so scrolling away and back keeps the
      // buttons working without re-attaching.
      const injected = ctx.dom.inject(target, '<div class="dnd-cyoa"></div>', 'beforeend')
      // `inject` returns its own wrapper around the parsed content, so reach
      // for the container that carries the layout class.
      build(injected.querySelector('.dnd-cyoa') ?? injected, choices, messageId)
      rendered.set(messageId, injected)
    },
  )

  return {
    dispose() {
      unsubscribe()
      for (const element of rendered.values()) ctx.dom.uninject(element)
      rendered.clear()
      removeStyle()
    },
  }
}
