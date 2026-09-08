/**
 * roll-review.ts — look at a rolled character before it replaces your own.
 *
 * The roll used to commit the moment the model answered, and the picker told
 * you the old sheet was recoverable from Edit raw. It wasn't: the prior memo
 * goes into `memoHistory`, which nothing in the UI reads. So a roll you didn't
 * like took your character with it.
 *
 * Reviewing first is the fix. Nothing is written until "Use this character",
 * and the sheet is editable, so a model that got one stat wrong doesn't cost
 * you a whole reroll.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type Draft = Extract<ToFrontend, { type: 'roll:draft' }>

interface ModalHandle {
  root: HTMLElement
  dismiss(): void
  onDismiss(handler: () => void): () => void
}

export const ROLL_REVIEW_CSS = `
.dnd-rollrev { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.dnd-rollrev__name { margin: 0; font-size: 1.15em; }
.dnd-rollrev__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-rollrev__head { display: flex; gap: 12px; align-items: flex-start; }
.dnd-rollrev__portrait {
  width: 88px; height: 88px; flex: 0 0 auto; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
}
.dnd-rollrev__sheet {
  width: 100%; min-height: 260px; padding: 10px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* Sheets are column-aligned text; a proportional font makes them unreadable. */
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  /* 16px or iOS Safari zooms the viewport on focus. */
  font-size: 16px; line-height: 1.5;
}
.dnd-rollrev__keep {
  width: 100%; min-height: 44px; padding: 12px; border-radius: 6px; cursor: pointer;
  font: inherit; font-weight: 600;
  border: 2px solid var(--lumiverse-primary, #00b4ff);
  background: var(--lumiverse-primary-soft, rgba(0,180,255,.22));
  color: var(--lumiverse-text, inherit);
}
.dnd-rollrev__keep:disabled { opacity: .5; cursor: default; }
.dnd-rollrev__row { display: flex; gap: 8px; }
.dnd-rollrev__row .dnd-panel__button { flex: 1 1 0; min-height: 40px; }
.dnd-rollrev__note { color: rgba(216,120,72,.95); line-height: 1.45; }
`

export interface RollReviewHandle {
  /** Feed a rerolled draft into the open modal rather than stacking another. */
  update(next: Draft): void
  close(): void
}

/**
 * Show the review.
 *
 * `reroll` re-runs the roll with the same picker choices; the caller feeds the
 * new draft back through `update`, because the host caps an extension at two
 * modals and the picker may still count as one.
 */
export function showRollReview(
  ctx: SpindleFrontendContext,
  draft: Draft,
  send: (message: ToBackend) => void,
  reroll: () => void,
  onClose: () => void,
): RollReviewHandle | null {
  if (!ctx.ui.showModal) return null

  let handle: ModalHandle
  try {
    // The name is shown in the body, not the title: a reroll changes it and
    // the host's title cannot be updated afterwards.
    handle = ctx.ui.showModal({
      title: 'Review your rolled character',
      width: 560,
    }) as ModalHandle
  } catch (error) {
    console.warn('[DnD] could not open the roll review:', error)
    return null
  }
  handle.onDismiss(onClose)

  const wrap = document.createElement('div')
  wrap.className = 'dnd-rollrev'

  const intro = document.createElement('p')
  intro.className = 'dnd-rollrev__intro'
  intro.textContent = 'Nothing has changed yet — your current character is still '
    + 'in place. Edit anything you want to keep, then use this character to '
    + 'replace the old sheet.'

  const name = document.createElement('h3')
  name.className = 'dnd-rollrev__name'

  const head = document.createElement('div')
  head.className = 'dnd-rollrev__head'

  const portrait = document.createElement('img')
  portrait.className = 'dnd-rollrev__portrait'
  portrait.alt = ''
  portrait.hidden = true

  const sheet = document.createElement('textarea')
  sheet.className = 'dnd-rollrev__sheet'
  sheet.spellcheck = false

  const keep = document.createElement('button')
  keep.type = 'button'
  keep.className = 'dnd-rollrev__keep'
  keep.textContent = 'Use this character'
  keep.addEventListener('click', () => {
    if (!sheet.value.trim()) return
    keep.disabled = true
    send({ type: 'roll:commit', memo: sheet.value })
    handle.dismiss()
    onClose()
  })

  const row = document.createElement('div')
  row.className = 'dnd-rollrev__row'

  const again = document.createElement('button')
  again.type = 'button'
  again.className = 'dnd-panel__button'
  again.textContent = 'Roll again'
  again.addEventListener('click', () => {
    again.disabled = true
    again.textContent = 'Rolling…'
    keep.disabled = true
    reroll()
  })

  const discard = document.createElement('button')
  discard.type = 'button'
  discard.className = 'dnd-panel__button'
  discard.textContent = 'Discard'
  discard.addEventListener('click', () => {
    handle.dismiss()
    onClose()
  })

  const note = document.createElement('div')
  note.className = 'dnd-rollrev__note'
  note.hidden = true

  const applyDraft = (next: Draft): void => {
    name.textContent = next.name ?? 'New character'
    sheet.value = next.memo ?? ''
    if (next.portraitUrl) {
      portrait.src = next.portraitUrl
      portrait.hidden = false
    } else {
      portrait.hidden = true
    }
  }
  applyDraft(draft)

  head.append(portrait, sheet)
  row.append(again, discard)
  wrap.append(name, intro, head, note, keep, row)
  handle.root.appendChild(wrap)

  return {
    update(next) {
      again.disabled = false
      again.textContent = 'Roll again'
      keep.disabled = false
      if (!next.ok) {
        // The previous draft is still in the box and still valid, so keep it
        // rather than clearing the box on a failed reroll.
        note.hidden = false
        note.textContent = next.reason
          ? `That reroll failed: ${next.reason}. The sheet below is the earlier roll.`
          : 'That reroll failed. The sheet below is the earlier roll.'
        return
      }
      note.hidden = true
      applyDraft(next)
    },
    close() {
      handle.dismiss()
    },
  }
}
