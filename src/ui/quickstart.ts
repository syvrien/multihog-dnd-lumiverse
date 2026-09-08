/**
 * quickstart.ts — Instant Action.
 *
 * The counterpart to `roll-character.ts`. That one asks you six questions and
 * shows you the sheet before it commits; this one asks for a genre and hands
 * back a started story. Both are worth having — they are different moods, not
 * different quality bars.
 *
 * Because it does commit, unattended, everything it is about to decide for you
 * is on screen before you press the button, and the running commentary names
 * each step: three model calls is long enough that a silent modal reads as a
 * hang.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

interface ModalHandle {
  root: HTMLElement
  dismiss(): void
  onDismiss(handler: () => void): () => void
}

/** The four genres `getArchetypesForGenre` has archetype pools for. */
const GENRES: Array<{ value: string; label: string }> = [
  { value: 'fantasy', label: 'Fantasy' },
  { value: 'realistic', label: 'Modern' },
  { value: 'scifi', label: 'Sci-fi' },
  { value: 'horror', label: 'Horror' },
]

export const QUICKSTART_CSS = `
.dnd-qs { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.dnd-qs__lede { line-height: 1.5; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-qs__genres { display: flex; gap: 8px; flex-wrap: wrap; }
.dnd-qs__genre {
  flex: 1 1 100px; min-height: 44px; padding: 10px; border-radius: 6px; cursor: pointer;
  font: inherit;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-surface, transparent);
  color: var(--lumiverse-text, inherit);
}
.dnd-qs__genre[aria-pressed="true"] {
  border-color: rgba(216,120,72,.85);
  background: rgba(216,120,72,.2);
  font-weight: 600;
}
.dnd-qs__field { display: flex; flex-direction: column; gap: 4px; }
.dnd-qs__field > span { color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-qs__row { display: flex; gap: 8px; align-items: stretch; }
.dnd-qs__row > input { flex: 1 1 auto; }
.dnd-qs input, .dnd-qs textarea {
  min-height: 40px; padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-qs textarea { min-height: 72px; resize: vertical; }
.dnd-qs__reroll {
  min-height: 40px; padding: 0 14px; border-radius: 6px; cursor: pointer; font: inherit;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-surface, transparent);
  color: var(--lumiverse-text, inherit);
}
.dnd-qs__check { display: flex; gap: 8px; align-items: center; line-height: 1.4; }
.dnd-qs__check input { min-height: 0; }
.dnd-qs__go {
  width: 100%; min-height: 44px; padding: 12px; border-radius: 6px; cursor: pointer;
  font: inherit; font-weight: 600;
  border: 2px solid rgba(216,120,72,.75);
  background: rgba(216,120,72,.2);
  color: var(--lumiverse-text, inherit);
}
.dnd-qs__go:disabled { opacity: .5; cursor: default; }
.dnd-qs__status {
  min-height: 20px; line-height: 1.45;
  color: var(--lumiverse-text-dim, rgba(160,160,160,.95));
  overflow-wrap: anywhere;
}
.dnd-qs__status--bad { color: rgba(224,128,96,.95); }
`

export interface QuickStartHandle {
  /** A rolled name arrived from the backend. */
  applyName(name: string): void
  /** Progress commentary. */
  applyStep(label: string): void
  /** The run finished, one way or the other. */
  applyDone(message: Extract<ToFrontend, { type: 'quickstart:done' }>): void
  close(): void
}

export function showQuickStart(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
  onClose: () => void,
): QuickStartHandle | null {
  if (!ctx.ui.showModal) return null

  let handle: ModalHandle
  try {
    handle = ctx.ui.showModal({ title: 'Instant Action', width: 520 }) as ModalHandle
  } catch (error) {
    console.warn('[DnD] could not open Instant Action:', error)
    return null
  }
  handle.onDismiss(onClose)

  const wrap = document.createElement('div')
  wrap.className = 'dnd-qs'

  const lede = document.createElement('p')
  lede.className = 'dnd-qs__lede'
  lede.textContent = 'Pick a genre and a character is rolled, written up as a '
    + 'Player Card, and dropped into an opening scene. Unlike Roll character, '
    + 'this commits without showing you the sheet first.'

  const genreWrap = document.createElement('div')
  genreWrap.className = 'dnd-qs__genres'
  let genre = ''
  const genreButtons: HTMLButtonElement[] = []
  for (const option of GENRES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dnd-qs__genre'
    button.textContent = option.label
    button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', () => {
      genre = option.value
      for (const other of genreButtons) {
        other.setAttribute('aria-pressed', String(other === button))
      }
      reroll.disabled = false
      go.disabled = false
      setStatus(`${option.label} selected — a name is optional.`)
    })
    genreButtons.push(button)
    genreWrap.appendChild(button)
  }

  const nameField = document.createElement('label')
  nameField.className = 'dnd-qs__field'
  const nameLabel = document.createElement('span')
  nameLabel.textContent = 'Name (optional — blank lets the model choose)'
  const nameRow = document.createElement('div')
  nameRow.className = 'dnd-qs__row'
  const name = document.createElement('input')
  name.type = 'text'
  name.placeholder = 'e.g. Kestrel'
  const reroll = document.createElement('button')
  reroll.type = 'button'
  reroll.className = 'dnd-qs__reroll'
  reroll.textContent = 'Roll a name'
  reroll.disabled = true
  reroll.addEventListener('click', () => {
    if (!genre) return
    send({ type: 'quickstart:roll-name', genre })
  })
  nameRow.append(name, reroll)
  nameField.append(nameLabel, nameRow)

  const setupField = document.createElement('label')
  setupField.className = 'dnd-qs__field'
  const setupLabel = document.createElement('span')
  setupLabel.textContent = 'Opening setup (optional)'
  const setup = document.createElement('textarea')
  setup.placeholder = 'e.g. Shipwrecked on a coast nobody charts. Level 3.'
  setup.maxLength = 1000
  setupField.append(setupLabel, setup)

  // Both default the way upstream does: a rolled level is the surprise people
  // want from Instant Action, and the story starting itself is the point.
  const randomLevel = document.createElement('label')
  randomLevel.className = 'dnd-qs__check'
  const randomLevelBox = document.createElement('input')
  randomLevelBox.type = 'checkbox'
  const randomLevelText = document.createElement('span')
  randomLevelText.textContent = 'Roll the starting level instead of using the configured one'
  randomLevel.append(randomLevelBox, randomLevelText)

  const starter = document.createElement('label')
  starter.className = 'dnd-qs__check'
  const starterBox = document.createElement('input')
  starterBox.type = 'checkbox'
  starterBox.checked = true
  const starterText = document.createElement('span')
  starterText.textContent = 'Send the opening turn once the character exists'
  starter.append(starterBox, starterText)

  const status = document.createElement('div')
  status.className = 'dnd-qs__status'
  const setStatus = (text: string, bad = false): void => {
    status.textContent = text
    status.classList.toggle('dnd-qs__status--bad', bad)
  }
  setStatus('Pick a genre to begin.')

  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'dnd-qs__go'
  go.textContent = 'Begin'
  go.disabled = true

  const setBusy = (busy: boolean): void => {
    go.disabled = busy || !genre
    reroll.disabled = busy || !genre
    name.disabled = busy
    setup.disabled = busy
    randomLevelBox.disabled = busy
    starterBox.disabled = busy
    for (const button of genreButtons) button.disabled = busy
  }

  go.addEventListener('click', () => {
    if (!genre) return
    setBusy(true)
    setStatus('Starting…')
    send({
      type: 'quickstart:run',
      genre,
      name: name.value.trim(),
      instructions: setup.value,
      randomLevel: randomLevelBox.checked,
      sendStarter: starterBox.checked,
    })
  })

  wrap.append(lede, genreWrap, nameField, setupField, randomLevel, starter, go, status)
  handle.root.appendChild(wrap)

  return {
    applyName(rolled: string): void {
      if (!rolled) {
        setStatus('No name pool for that genre — type one or leave it blank.')
        return
      }
      name.value = rolled
      setStatus('Name ready — reroll, edit, or begin.')
    },
    applyStep(label: string): void {
      setStatus(label)
    },
    applyDone(message): void {
      setBusy(false)
      if (!message.ok) {
        setStatus(message.reason ?? 'Quick Start failed.', true)
        return
      }
      // Leave the modal open on success only long enough to say who you are;
      // the story is already in the chat behind it.
      setStatus(`Ready — ${message.name ?? 'your character'} (${message.detail ?? ''}).`)
      handle.dismiss()
    },
    close(): void {
      handle.dismiss()
    },
  }
}
