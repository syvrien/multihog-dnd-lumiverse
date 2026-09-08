/**
 * portrait.ts — the picker behind an entity card's portrait box.
 *
 * Three ways in, in the order most people will want them: a persona's avatar,
 * a file from disk, a URL. Dropping a file straight onto the card skips this
 * modal entirely — the tooltip has always said you can, and now you can.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

type Options = Extract<ToFrontend, { type: 'portrait:options' }>

interface ModalHandle {
  root: HTMLElement
  dismiss(): void
  onDismiss(handler: () => void): () => void
}

export const PORTRAIT_CSS = `
.dnd-portrait { display: flex; flex-direction: column; gap: 14px; padding: 16px; }
.dnd-portrait__intro { margin: 0; line-height: 1.45; color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-portrait__current { display: flex; gap: 12px; align-items: center; }
.dnd-portrait__current img {
  width: 72px; height: 72px; object-fit: cover; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
}
.dnd-portrait__group { display: flex; flex-direction: column; gap: 6px; }
.dnd-portrait__group > span { color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-portrait__row { display: flex; gap: 8px; }
.dnd-portrait__row > *:first-child { flex: 1 1 auto; min-width: 0; }
.dnd-portrait select, .dnd-portrait input[type="text"] {
  min-height: 40px; padding: 8px 10px; border-radius: 6px; width: 100%;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-portrait__file { font: inherit; }
.dnd-portrait__remove { align-self: flex-start; }
.dnd-portrait__note { color: rgba(216,120,72,.95); line-height: 1.45; }
/* The card's portrait box is now interactive, so it should look it. */
.rt-entity-portrait-container { cursor: pointer; }
.rt-entity-portrait-container.dnd-portrait-drop {
  outline: 2px dashed var(--lumiverse-primary, #00b4ff); outline-offset: 2px;
}
`

/** Read a picked or dropped file as a data URL for upload. */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('could not read that file'))
    reader.readAsDataURL(file)
  })
}

export function showPortraitPicker(
  ctx: SpindleFrontendContext,
  options: Options,
  send: (message: ToBackend) => void,
  onClose: () => void,
): { close(): void } | null {
  if (!ctx.ui.showModal) return null

  let handle: ModalHandle
  try {
    handle = ctx.ui.showModal({ title: `Portrait — ${options.entity}`, width: 480 }) as ModalHandle
  } catch (error) {
    console.warn('[DnD] could not open the portrait picker:', error)
    return null
  }
  handle.onDismiss(onClose)

  const wrap = document.createElement('div')
  wrap.className = 'dnd-portrait'

  const note = document.createElement('div')
  note.className = 'dnd-portrait__note'
  note.hidden = true

  const finish = (message: ToBackend): void => {
    send(message)
    handle.dismiss()
    onClose()
  }

  const group = (labelText: string, control: HTMLElement): HTMLElement => {
    const label = document.createElement('label')
    label.className = 'dnd-portrait__group'
    const span = document.createElement('span')
    span.textContent = labelText
    label.append(span, control)
    return label
  }

  // What is there now, so "remove" is an obvious option rather than a guess.
  const current = document.createElement('div')
  current.className = 'dnd-portrait__current'
  if (options.current) {
    const img = document.createElement('img')
    img.src = options.current
    img.alt = ''
    const caption = document.createElement('span')
    caption.textContent = 'Current portrait'
    current.append(img, caption)
  } else {
    const intro = document.createElement('p')
    intro.className = 'dnd-portrait__intro'
    intro.textContent = 'No portrait yet. You can also drop an image straight '
      + 'onto the card.'
    current.appendChild(intro)
  }

  const persona = document.createElement('select')
  const none = document.createElement('option')
  none.value = ''
  none.textContent = options.personas.length
    ? 'Choose a persona…'
    : 'No personas with an image'
  persona.appendChild(none)
  for (const entry of options.personas) {
    const option = document.createElement('option')
    option.value = entry.id
    option.textContent = entry.name
    persona.appendChild(option)
  }
  persona.disabled = options.personas.length === 0
  persona.addEventListener('change', () => {
    if (!persona.value) return
    finish({ type: 'portrait:set', entity: options.entity, personaId: persona.value })
  })

  const file = document.createElement('input')
  file.type = 'file'
  file.accept = 'image/*'
  file.className = 'dnd-portrait__file'
  file.addEventListener('change', () => {
    const picked = file.files?.[0]
    if (!picked) return
    readDataUrl(picked)
      .then(dataUrl => {
        finish({
          type: 'portrait:set', entity: options.entity, dataUrl, filename: picked.name,
        })
      })
      .catch((error: Error) => {
        note.hidden = false
        note.textContent = `Could not read that file: ${error.message}`
      })
  })

  const url = document.createElement('input')
  url.type = 'text'
  url.placeholder = 'https://…'
  const useUrl = document.createElement('button')
  useUrl.type = 'button'
  useUrl.className = 'dnd-panel__button'
  useUrl.textContent = 'Use'
  const submitUrl = (): void => {
    const value = url.value.trim()
    if (!value) return
    finish({ type: 'portrait:set', entity: options.entity, url: value })
  }
  useUrl.addEventListener('click', submitUrl)
  url.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Enter') submitUrl()
  })
  const urlRow = document.createElement('div')
  urlRow.className = 'dnd-portrait__row'
  urlRow.append(url, useUrl)

  wrap.append(
    current,
    group('Use a persona’s image', persona),
    group('Upload an image', file),
    group('Or paste an image URL', urlRow),
    note,
  )

  if (options.current) {
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'dnd-panel__button dnd-portrait__remove'
    remove.textContent = 'Remove portrait'
    remove.addEventListener('click', () => {
      finish({ type: 'portrait:clear', entity: options.entity })
    })
    wrap.appendChild(remove)
  }

  handle.root.appendChild(wrap)
  return {
    close() {
      handle.dismiss()
    },
  }
}

/**
 * Make every portrait box on a rendered panel clickable and droppable.
 *
 * Called on each render, because the markup is replaced wholesale.
 */
export function bindPortraitBoxes(
  root: Element,
  send: (message: ToBackend) => void,
): void {
  for (const box of root.querySelectorAll('.rt-entity-portrait-container')) {
    const entity = box.closest('[data-entity-name]')?.getAttribute('data-entity-name') ?? ''
    if (!entity) continue

    box.addEventListener('click', event => {
      // The card header above it toggles collapse; a portrait click is not that.
      event.preventDefault()
      event.stopPropagation()
      send({ type: 'portrait:open', entity })
    })

    // Dropping a file is what the box's own tooltip has always promised.
    box.addEventListener('dragover', event => {
      event.preventDefault()
      box.classList.add('dnd-portrait-drop')
    })
    box.addEventListener('dragleave', () => box.classList.remove('dnd-portrait-drop'))
    box.addEventListener('drop', event => {
      event.preventDefault()
      event.stopPropagation()
      box.classList.remove('dnd-portrait-drop')
      const dropped = (event as DragEvent).dataTransfer?.files?.[0]
      if (!dropped || !dropped.type.startsWith('image/')) return
      void readDataUrl(dropped)
        .then(dataUrl => {
          send({ type: 'portrait:set', entity, dataUrl, filename: dropped.name })
        })
        .catch((error: Error) => {
          console.warn('[DnD] could not read the dropped image:', error.message)
        })
    })
  }
}
