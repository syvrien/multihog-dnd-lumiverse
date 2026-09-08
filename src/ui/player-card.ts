/**
 * player-card.ts — review a generated Player Card before it is stored.
 *
 * Upstream builds this overlay as hand-written DOM with inline styles against
 * SillyTavern's page. Here it is rebuilt on `ctx.ui.showModal()`, so it inherits
 * the host's chrome — backdrop, header, Escape — and the theme.
 *
 * The review step is the point: the bio is editable, and what gets stored is
 * whatever the user leaves in the box, not what the model produced.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type Preview = Extract<ToFrontend, { type: 'pc:preview' }>

interface ModalHandle {
  root: HTMLElement
  dismiss(): void
  onDismiss(handler: () => void): () => void
}

export const PLAYER_CARD_CSS = `
.dnd-pc { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.dnd-pc__intro { line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-pc__bio {
  width: 100%; min-height: 240px; padding: 10px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px; line-height: 1.5;
}
.dnd-pc__add {
  width: 100%; min-height: 44px; padding: 12px; border-radius: 6px; cursor: pointer;
  font: inherit; font-weight: 600;
  border: 2px solid var(--lumiverse-primary, #00b4ff);
  background: var(--lumiverse-primary-soft, rgba(0,180,255,.22));
  color: var(--lumiverse-text, inherit);
}
.dnd-pc__row { display: flex; gap: 8px; }
.dnd-pc__row .dnd-panel__button { flex: 1 1 0; min-height: 40px; }
.dnd-pc__note { color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
`

/**
 * Show the review modal.
 *
 * `regenerate` re-runs generation and the caller feeds the new draft back in
 * through the returned `update`, so a regeneration reuses this modal rather
 * than stacking a second one (the host caps an extension at two).
 */
export function showPlayerCardPreview(
  ctx: SpindleFrontendContext,
  draft: Preview,
  send: (message: ToBackend) => void,
  onClose: () => void,
): { update(next: Preview): void } | null {
  if (!ctx.ui.showModal) return null

  let handle: ModalHandle
  try {
    handle = ctx.ui.showModal({
      title: `Player Card — ${draft.name}`,
      width: 560,
    }) as ModalHandle
  } catch (error) {
    console.warn('[DnD] could not open the Player Card modal:', error)
    return null
  }

  // Dismissing leaves the caller holding a handle to a modal that is gone; a
  // later regeneration would then update nothing.
  handle.onDismiss(onClose)

  const wrap = document.createElement('div')
  wrap.className = 'dnd-pc'

  const intro = document.createElement('p')
  intro.className = 'dnd-pc__intro'
  intro.textContent = 'Edit the Lorebook Agent Player Card below, then add it to '
    + 'this chat. The agent loads it whenever you open this chat.'

  const bio = document.createElement('textarea')
  bio.className = 'dnd-pc__bio'
  bio.value = draft.bio

  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'dnd-pc__add'
  add.textContent = 'Add as Player into Lorebook Agent'
  add.addEventListener('click', () => {
    send({
      type: 'pc:add',
      name: draft.name,
      bio: bio.value,
      wordCount: draft.wordCount,
    })
    handle.dismiss()
    onClose()
  })

  const row = document.createElement('div')
  row.className = 'dnd-pc__row'

  const regenerate = document.createElement('button')
  regenerate.type = 'button'
  regenerate.className = 'dnd-panel__button'
  regenerate.textContent = 'Regenerate'
  regenerate.addEventListener('click', () => {
    regenerate.disabled = true
    regenerate.textContent = 'Regenerating…'
    send({ type: 'pc:generate' })
  })

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'dnd-panel__button'
  copy.textContent = 'Copy bio'
  copy.addEventListener('click', () => {
    // Clipboard access can be denied; say so rather than failing silently.
    void navigator.clipboard?.writeText(bio.value)
      .then(() => { copy.textContent = 'Copied' })
      .catch(() => { copy.textContent = 'Copy blocked' })
      .finally(() => {
        setTimeout(() => { copy.textContent = 'Copy bio' }, 1500)
      })
  })

  row.append(regenerate, copy)
  wrap.append(intro, bio, add, row)
  handle.root.appendChild(wrap)

  return {
    update(next: Preview) {
      regenerate.disabled = false
      regenerate.textContent = 'Regenerate'
      if (!next.ok) {
        const note = document.createElement('div')
        note.className = 'dnd-pc__note'
        note.textContent = next.reason
          ? `Regeneration failed: ${next.reason}`
          : 'Regeneration failed.'
        wrap.appendChild(note)
        return
      }
      bio.value = next.bio
    },
  }
}
