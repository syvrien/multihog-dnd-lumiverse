/**
 * companion.ts — the Adventure Companion panel.
 *
 * Upstream this is a floating, draggable, detachable window that morphs out of
 * the tracker panel. Here it is its own drawer tab: a transcript, a box to type
 * in, and the switches controlling what the companion is allowed to see.
 *
 * The transcript is owned by the backend and repainted whole on every change.
 * Keeping a second copy here would mean two histories to disagree after a chat
 * switch, which is the bug the tracker itself had.
 */

import type { SpindleDrawerTabHandle, SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type State = Extract<ToFrontend, { type: 'companion:state' }>

export const COMPANION_CSS = `
.dnd-comp { display: flex; flex-direction: column; height: 100%; gap: 8px; padding: 8px; }
.dnd-comp__log {
  flex: 1 1 auto; min-height: 160px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 8px; padding-right: 4px;
}
.dnd-comp__msg { padding: 8px 10px; border-radius: 8px; line-height: 1.45; white-space: pre-wrap; }
.dnd-comp__msg--user {
  background: var(--lumiverse-primary-soft, rgba(0,180,255,.15));
  align-self: flex-end; max-width: 85%;
}
.dnd-comp__msg--bot {
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.3));
  align-self: flex-start; max-width: 95%;
}
.dnd-comp__who {
  font-size: .8em; opacity: .7; margin-bottom: 2px;
  text-transform: uppercase; letter-spacing: .04em;
}
.dnd-comp__empty { opacity: .7; line-height: 1.5; padding: 8px; }
.dnd-comp__row { display: flex; gap: 6px; align-items: flex-end; }
.dnd-comp__input {
  flex: 1 1 auto; min-height: 44px; max-height: 140px; padding: 10px; border-radius: 6px;
  resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-comp__send {
  min-height: 44px; padding: 10px 16px; border-radius: 6px; cursor: pointer;
  font: inherit; font-weight: 600;
  border: 2px solid var(--lumiverse-primary, #00b4ff);
  background: var(--lumiverse-primary-soft, rgba(0,180,255,.22));
  color: var(--lumiverse-text, inherit);
}
.dnd-comp__send:disabled { opacity: .5; cursor: default; }
.dnd-comp__opts {
  display: flex; flex-wrap: wrap; gap: 10px 14px; padding: 6px 2px;
  border-top: 1px solid var(--lumiverse-border, rgba(128,128,128,.25));
}
.dnd-comp__opt { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.dnd-comp__opt input { cursor: pointer; }
.dnd-comp__look { width: 64px; }
.dnd-comp__foot { display: flex; gap: 8px; justify-content: space-between; align-items: center; }
`

const TAB_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">'
  + '<path d="M3 5.5h14v9H8l-4 3v-3H3z"/><path d="M7 9h6M7 11.5h4"/></svg>'

/** What the companion may look at, in the order they matter. */
const TOGGLES: Array<{ key: keyof State['prefs']; label: string; help: string }> = [
  { key: 'injectMemo', label: 'State', help: 'Show it the tracker memo' },
  { key: 'injectLore', label: 'Lore', help: 'Show it the Lorebook Agent entries' },
  { key: 'injectMap', label: 'Map', help: 'Show it the active site map' },
  { key: 'tutorialMode', label: 'Tutorial', help: 'Let it answer from the extension manual' },
]

export interface CompanionHandle {
  apply(state: State): void
  dispose(): void
}

export function installCompanion(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
): CompanionHandle {
  let tab: SpindleDrawerTabHandle
  try {
    tab = ctx.ui.registerDrawerTab({
      id: 'companion',
      title: 'Adventure Companion',
      shortName: 'Companion',
      description: 'Ask a friend who can see your campaign — and act on it',
      keywords: ['companion', 'chat', 'gm', 'help', 'tutorial', 'dnd'],
      headerTitle: 'Companion',
      iconSvg: TAB_ICON,
    })
  } catch (error) {
    console.warn('[DnD] could not register the companion tab:', error)
    return { apply() {}, dispose() {} }
  }

  const root = ctx.dom.createElement('div', { class: 'dnd-comp' })
  const log = ctx.dom.createElement('div', { class: 'dnd-comp__log' })

  const opts = ctx.dom.createElement('div', { class: 'dnd-comp__opts' })
  const toggleInputs = new Map<string, HTMLInputElement>()
  for (const toggle of TOGGLES) {
    const label = ctx.dom.createElement('label', { class: 'dnd-comp__opt', title: toggle.help })
    const input = ctx.dom.createElement('input', { type: 'checkbox' }) as HTMLInputElement
    input.addEventListener('change', () => {
      send({ type: 'companion:prefs', patch: { [toggle.key]: input.checked } })
    })
    const text = ctx.dom.createElement('span')
    text.textContent = toggle.label
    label.append(input, text)
    opts.appendChild(label)
    toggleInputs.set(toggle.key, input)
  }

  // How much of the story it reads back. 0 means "none"; the All box overrides.
  const lookLabel = ctx.dom.createElement('label', {
    class: 'dnd-comp__opt',
    title: 'How many recent story messages it can read',
  })
  const look = ctx.dom.createElement('input', {
    type: 'number', class: 'dnd-comp__look', min: '0', max: '200',
  }) as HTMLInputElement
  look.addEventListener('change', () => {
    send({ type: 'companion:prefs', patch: { lookback: Number(look.value) || 0 } })
  })
  const lookText = ctx.dom.createElement('span')
  lookText.textContent = 'Story'
  lookLabel.append(lookText, look)
  opts.appendChild(lookLabel)

  const input = ctx.dom.createElement('textarea', {
    class: 'dnd-comp__input',
    placeholder: 'Ask about your campaign, or tell it what to do…',
  }) as HTMLTextAreaElement
  input.rows = 2

  const sendBtn = ctx.dom.createElement('button', {
    class: 'dnd-comp__send', type: 'button',
  }) as HTMLButtonElement
  sendBtn.textContent = 'Send'

  let busy = false
  const submit = (): void => {
    const text = input.value.trim()
    if (!text || busy) return
    input.value = ''
    send({ type: 'companion:ask', text })
  }
  sendBtn.addEventListener('click', () => {
    // While a turn is running the same button cancels it — there is only room
    // for one, and a stuck turn needs a way out.
    if (busy) send({ type: 'companion:cancel' })
    else submit()
  })
  input.addEventListener('keydown', event => {
    const key = event as KeyboardEvent
    // Enter sends; Shift+Enter is a newline, as in every chat box.
    if (key.key === 'Enter' && !key.shiftKey) {
      event.preventDefault()
      submit()
    }
  })

  const row = ctx.dom.createElement('div', { class: 'dnd-comp__row' })
  row.append(input, sendBtn)

  const clear = ctx.dom.createElement('button', {
    class: 'dnd-panel__button', type: 'button',
  }) as HTMLButtonElement
  clear.textContent = 'Clear conversation'
  clear.addEventListener('click', () => send({ type: 'companion:clear' }))

  const note = ctx.dom.createElement('div', { class: 'dnd-comp__empty' })
  note.textContent = 'It can also act: run a tracker pass, run the Lorebook Agent, '
    + 'update the map, or take a turn for you.'

  const foot = ctx.dom.createElement('div', { class: 'dnd-comp__foot' })
  foot.append(clear)

  root.append(log, opts, row, foot)
  tab.root.appendChild(root)

  // The first repaint is requested from `setup()`, after the backend-message
  // handler exists — asking here races the reply against the listener.

  return {
    apply(state) {
      busy = state.busy
      sendBtn.textContent = busy ? 'Stop' : 'Send'
      input.disabled = busy

      for (const [key, control] of toggleInputs) {
        control.checked = !!state.prefs[key as keyof State['prefs']]
      }
      look.value = String(state.prefs.lookbackAll ? 0 : state.prefs.lookback)

      log.textContent = ''
      if (!state.history.length) {
        const empty = ctx.dom.createElement('div', { class: 'dnd-comp__empty' })
        empty.textContent = 'Nothing yet. Ask it what is going on in your campaign, '
          + 'or what a rule does.'
        log.append(empty, note)
        return
      }

      for (const entry of state.history) {
        const bubble = ctx.dom.createElement('div', {
          class: `dnd-comp__msg dnd-comp__msg--${entry.role === 'user' ? 'user' : 'bot'}`,
        })
        const who = ctx.dom.createElement('div', { class: 'dnd-comp__who' })
        who.textContent = entry.role === 'user' ? 'You' : 'Companion'
        const body = ctx.dom.createElement('div')
        // textContent, not innerHTML: this is model output.
        body.textContent = entry.content
        bubble.append(who, body)
        log.appendChild(bubble)
      }
      if (busy) {
        const pending = ctx.dom.createElement('div', {
          class: 'dnd-comp__msg dnd-comp__msg--bot',
        })
        pending.textContent = 'Thinking…'
        log.appendChild(pending)
      }
      log.scrollTop = log.scrollHeight
    },
    dispose() {
      tab.destroy()
    },
  }
}
