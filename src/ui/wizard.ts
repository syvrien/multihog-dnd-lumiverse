/**
 * wizard.ts — the Game System Wizard.
 *
 * Two steps in one modal. Describe a mechanic, then read what the model drafted
 * before any of it reaches your campaign — the same rule as rolling a character
 * and creating a Player Card, and for the same reason: a Game System adds rules
 * to every prompt and a field to the tracker card.
 *
 * Both halves are editable in the preview. The model is good at the shape and
 * frequently wrong about a detail, and fixing one line is much cheaper than
 * regenerating and hoping.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type Draft = Extract<ToFrontend, { type: 'wizard:draft' }>
type Examples = Extract<ToFrontend, { type: 'wizard:examples' }>

interface ModalHandle {
  root: HTMLElement
  dismiss(): void
  onDismiss(handler: () => void): () => void
}

export const WIZARD_CSS = `
.dnd-wiz { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.dnd-wiz__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-wiz__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dnd-wiz__chip {
  font: inherit; font-size: .9em; cursor: pointer; padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.4));
  background: transparent; color: var(--lumiverse-text, inherit);
}
.dnd-wiz__desc, .dnd-wiz__body {
  width: 100%; padding: 10px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px; line-height: 1.5;
}
.dnd-wiz__desc { min-height: 90px; }
.dnd-wiz__body { min-height: 150px; font-family: ui-monospace, Consolas, monospace; font-size: 14px; }
.dnd-wiz__go {
  width: 100%; min-height: 44px; padding: 12px; border-radius: 6px; cursor: pointer;
  font: inherit; font-weight: 600;
  border: 2px solid var(--lumiverse-primary, #00b4ff);
  background: var(--lumiverse-primary-soft, rgba(0,180,255,.22));
  color: var(--lumiverse-text, inherit);
}
.dnd-wiz__go:disabled { opacity: .5; cursor: default; }
.dnd-wiz__row { display: flex; gap: 8px; }
.dnd-wiz__row .dnd-panel__button { flex: 1 1 0; min-height: 40px; }
.dnd-wiz__label { font-size: .85em; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-wiz__name { margin: 0; font-size: 1.15em; }
.dnd-wiz__opt { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.dnd-wiz__opts { display: flex; flex-wrap: wrap; gap: 10px 16px; }
.dnd-wiz__note { color: rgba(216,120,72,.95); line-height: 1.45; }
`

export interface WizardHandle {
  applyExamples(message: Examples): void
  applyDraft(message: Draft): void
  close(): void
}

export function showWizard(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
  onClose: () => void,
): WizardHandle | null {
  if (!ctx.ui.showModal) return null

  let handle: ModalHandle
  try {
    handle = ctx.ui.showModal({ title: 'New Game System', width: 620 }) as ModalHandle
  } catch (error) {
    console.warn('[DnD] could not open the wizard:', error)
    return null
  }
  handle.onDismiss(onClose)

  const wrap = document.createElement('div')
  wrap.className = 'dnd-wiz'

  // ── step one: describe it ───────────────────────────────────────────────
  const intro = document.createElement('p')
  intro.className = 'dnd-wiz__intro'
  intro.textContent = 'Describe a mechanic and it will be drafted as two halves: '
    + 'the rules the narrator follows, and the field on your tracker card that '
    + 'carries the number.'

  const chips = document.createElement('div')
  chips.className = 'dnd-wiz__chips'

  const desc = document.createElement('textarea')
  desc.className = 'dnd-wiz__desc'
  desc.placeholder = 'e.g. Radiation zones: exposure builds while in contaminated '
    + 'areas, causes sickness past a threshold, and is reduced by shelter or meds.'

  const owner = document.createElement('select')
  for (const [value, label] of [
    ['tracker', 'The tracker states it plainly'],
    ['gm', 'The narrator works it into the prose'],
  ] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    owner.appendChild(option)
  }
  const ownerLabel = document.createElement('label')
  ownerLabel.className = 'dnd-wiz__label'
  ownerLabel.textContent = 'When a threshold is crossed'
  ownerLabel.appendChild(owner)

  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'dnd-wiz__go'
  go.textContent = 'Design it'
  go.addEventListener('click', () => {
    if (!desc.value.trim()) { desc.focus(); return }
    go.disabled = true
    go.textContent = 'Designing…'
    note.hidden = true
    send({
      type: 'wizard:draft',
      description: desc.value.trim(),
      effectOwner: owner.value as 'tracker' | 'gm',
    })
  })

  const note = document.createElement('div')
  note.className = 'dnd-wiz__note'
  note.hidden = true

  const step1 = document.createElement('div')
  step1.className = 'dnd-wiz'
  step1.style.padding = '0'
  step1.append(intro, chips, desc, ownerLabel, go, note)

  // ── step two: read it before it lands ───────────────────────────────────
  const step2 = document.createElement('div')
  step2.className = 'dnd-wiz'
  step2.style.padding = '0'
  step2.hidden = true

  const name = document.createElement('h3')
  name.className = 'dnd-wiz__name'

  const review = document.createElement('p')
  review.className = 'dnd-wiz__intro'
  review.textContent = 'Nothing has been added yet. Edit either half before saving.'

  const gmLabel = document.createElement('div')
  gmLabel.className = 'dnd-wiz__label'
  gmLabel.textContent = 'Rules given to the narrator'
  const gmBody = document.createElement('textarea')
  gmBody.className = 'dnd-wiz__body'
  gmBody.spellcheck = false

  const trackerLabel = document.createElement('div')
  trackerLabel.className = 'dnd-wiz__label'
  trackerLabel.textContent = 'Tracked field'
  const trackerBody = document.createElement('textarea')
  trackerBody.className = 'dnd-wiz__body'
  trackerBody.spellcheck = false

  // What moves the value. At least one is required, or the field never changes.
  const drivers = document.createElement('div')
  drivers.className = 'dnd-wiz__opts'
  const driverBoxes = new Map<string, HTMLInputElement>()
  for (const [key, label] of [
    ['driverTime', 'Time passing'],
    ['driverGmAnnotation', 'The narrator declaring a change'],
    ['driverStatedFact', 'A number stated in the story'],
  ] as const) {
    const wrapLabel = document.createElement('label')
    wrapLabel.className = 'dnd-wiz__opt'
    const box = document.createElement('input')
    box.type = 'checkbox'
    const text = document.createElement('span')
    text.textContent = label
    wrapLabel.append(box, text)
    drivers.appendChild(wrapLabel)
    driverBoxes.set(key, box)
  }
  const driversLabel = document.createElement('div')
  driversLabel.className = 'dnd-wiz__label'
  driversLabel.textContent = 'What changes the value'

  let current: NonNullable<Draft['draft']> | null = null

  const collect = (enable: boolean): void => {
    if (!current) return
    send({
      type: 'wizard:save',
      enable,
      draft: {
        ...current,
        gmContent: gmBody.value,
        trackerContent: trackerBody.value,
        driverTime: !!driverBoxes.get('driverTime')?.checked,
        driverGmAnnotation: !!driverBoxes.get('driverGmAnnotation')?.checked,
        driverStatedFact: !!driverBoxes.get('driverStatedFact')?.checked,
      },
    })
    handle.dismiss()
    onClose()
  }

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'dnd-wiz__go'
  save.textContent = 'Save and switch on'
  save.addEventListener('click', () => collect(true))

  const row = document.createElement('div')
  row.className = 'dnd-wiz__row'
  const saveOnly = document.createElement('button')
  saveOnly.type = 'button'
  saveOnly.className = 'dnd-panel__button'
  saveOnly.textContent = 'Save, switched off'
  saveOnly.addEventListener('click', () => collect(false))
  const again = document.createElement('button')
  again.type = 'button'
  again.className = 'dnd-panel__button'
  again.textContent = 'Start over'
  again.addEventListener('click', () => {
    step2.hidden = true
    step1.hidden = false
    go.disabled = false
    go.textContent = 'Design it'
  })
  row.append(saveOnly, again)

  step2.append(name, review, gmLabel, gmBody, trackerLabel, trackerBody,
    driversLabel, drivers, save, row)

  wrap.append(step1, step2)
  handle.root.appendChild(wrap)
  send({ type: 'wizard:open' })

  return {
    applyExamples(message) {
      chips.textContent = ''
      for (const example of message.examples) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'dnd-wiz__chip'
        chip.textContent = example.label
        chip.addEventListener('click', () => {
          desc.value = example.text
          desc.focus()
        })
        chips.appendChild(chip)
      }
    },
    applyDraft(message) {
      go.disabled = false
      go.textContent = 'Design it'
      if (!message.ok || !message.draft) {
        note.hidden = false
        note.textContent = message.reason
          ? `Could not design that: ${message.reason}`
          : 'Could not design that.'
        return
      }
      current = message.draft
      name.textContent = `${message.draft.icon} ${message.draft.name}`
      gmBody.value = message.draft.gmContent
      gmLabel.hidden = !message.draft.includeGm
      gmBody.hidden = !message.draft.includeGm
      trackerBody.value = message.draft.trackerContent
      trackerLabel.hidden = !message.draft.includeTracker
      trackerBody.hidden = !message.draft.includeTracker
      driversLabel.hidden = !message.draft.includeTracker
      drivers.hidden = !message.draft.includeTracker
      driverBoxes.get('driverTime')!.checked = message.draft.driverTime
      driverBoxes.get('driverGmAnnotation')!.checked = message.draft.driverGmAnnotation
      driverBoxes.get('driverStatedFact')!.checked = message.draft.driverStatedFact
      step1.hidden = true
      step2.hidden = false
    },
    close() {
      handle.dismiss()
    },
  }
}
