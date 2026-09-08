/**
 * roll-character.ts — the "Roll character" picker.
 *
 * Upstream's Quick Start: choose a genre and class archetype and the model
 * authors a fresh sheet — new name, stats, gear, traits.
 *
 * The result **replaces the current character**, so rolling does not commit:
 * the sheet goes to `roll-review.ts` and the user decides there. This modal is
 * only the choices.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import type { ToBackend, ToFrontend } from '../shared/protocol'

/** Sentinels `buildCharacterGenerationPrompt` understands. */
const CLASS_OTHER = '__other__'
const CLASS_STORY = '__story__'

type Options = Extract<ToFrontend, { type: 'roll:options' }>

interface ModalHandle {
  root: HTMLElement
  dismiss(): void
  onDismiss(handler: () => void): () => void
}

/** Genre keys the engine uses, with labels for the picker. */
const GENRE_LABELS: Record<string, string> = {
  fantasy: 'Fantasy',
  scifi: 'Sci-fi',
  modern: 'Modern',
  horror: 'Horror',
  postapoc: 'Post-apocalyptic',
  historical: 'Historical',
}

const GEAR_TIERS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Gear: automatic' },
  { value: 'none', label: 'Gear: none' },
  { value: 'basic', label: 'Gear: basic' },
  { value: 'standard', label: 'Gear: standard' },
  { value: 'rich', label: 'Gear: well equipped' },
]

export const ROLL_CSS = `
.dnd-roll { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.dnd-roll__warn {
  padding: 10px; border-radius: 6px; line-height: 1.45;
  border: 1px solid rgba(216,120,72,.6);
  color: var(--lumiverse-text, inherit);
}
.dnd-roll__field { display: flex; flex-direction: column; gap: 4px; }
.dnd-roll__field > span { color: var(--lumiverse-text-dim, rgba(160,160,160,.95)); }
.dnd-roll select, .dnd-roll input {
  min-height: 40px; padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-roll__go {
  width: 100%; min-height: 44px; padding: 12px; border-radius: 6px; cursor: pointer;
  font: inherit; font-weight: 600;
  border: 2px solid rgba(216,120,72,.75);
  background: rgba(216,120,72,.2);
  color: var(--lumiverse-text, inherit);
}
.dnd-roll__go:disabled { opacity: .5; cursor: default; }
`

export interface RollHandle {
  /** Fill the picker once the backend answers with the archetype list. */
  apply(options: Options): void
  close(): void
}

export function showRollPicker(
  ctx: SpindleFrontendContext,
  send: (message: ToBackend) => void,
  onClose: () => void,
): RollHandle | null {
  if (!ctx.ui.showModal) return null

  let handle: ModalHandle
  try {
    handle = ctx.ui.showModal({ title: 'Roll a new character', width: 520 }) as ModalHandle
  } catch (error) {
    console.warn('[DnD] could not open the roll picker:', error)
    return null
  }
  handle.onDismiss(onClose)

  const wrap = document.createElement('div')
  wrap.className = 'dnd-roll'

  const warn = document.createElement('div')
  warn.className = 'dnd-roll__warn'
  warn.textContent = 'The model writes a fresh character sheet. You get to read '
    + 'it and edit it before it replaces the one you have.'

  const field = (labelText: string, control: HTMLElement): HTMLElement => {
    const label = document.createElement('label')
    label.className = 'dnd-roll__field'
    const span = document.createElement('span')
    span.textContent = labelText
    label.append(span, control)
    return label
  }

  // Seeding from a persona reuses its description and, more usefully, its
  // avatar — a portrait without needing an image-generation provider.
  const persona = document.createElement('select')

  const genre = document.createElement('select')
  const archetype = document.createElement('select')

  // Upstream's prompt builder takes a free-text class through `__other__`.
  const classOther = document.createElement('input')
  classOther.type = 'text'
  classOther.placeholder = 'e.g. Storm-touched cartographer'
  const classOtherField = document.createElement('div')
  classOtherField.hidden = true

  archetype.addEventListener('change', () => {
    classOtherField.hidden = archetype.value !== CLASS_OTHER
    if (!classOtherField.hidden) classOther.focus()
  })
  const level = document.createElement('input')
  level.type = 'number'
  level.min = '1'
  level.max = '20'
  level.value = '1'
  const gear = document.createElement('select')
  for (const tier of GEAR_TIERS) {
    const option = document.createElement('option')
    option.value = tier.value
    option.textContent = tier.label
    gear.appendChild(option)
  }
  const name = document.createElement('input')
  name.type = 'text'
  name.placeholder = 'Leave blank to let the model name them'

  // Changing genre changes the archetype list, which only the backend knows.
  genre.addEventListener('change', () => {
    archetype.textContent = ''
    const loading = document.createElement('option')
    loading.textContent = 'Loading…'
    archetype.appendChild(loading)
    send({ type: 'roll:open', genre: genre.value })
  })

  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'dnd-roll__go'
  go.textContent = 'Roll character'
  go.disabled = true
  go.addEventListener('click', () => {
    if (!archetype.value) return
    if (archetype.value === CLASS_OTHER && !classOther.value.trim()) {
      classOther.focus()
      return
    }
    go.disabled = true
    go.textContent = 'Rolling…'
    send({
      type: 'roll:go',
      className: archetype.value,
      classOther: classOther.value.trim() || undefined,
      genre: genre.value,
      level: Number(level.value) || 1,
      gearTier: gear.value,
      name: name.value.trim() || undefined,
      personaId: persona.value || undefined,
    })
    handle.dismiss()
    onClose()
  })

  classOtherField.append(field('Describe the class', classOther))

  wrap.append(
    warn,
    field('Base on a persona (optional)', persona),
    field('Genre', genre),
    field('Class archetype', archetype),
    classOtherField,
    field('Level', level),
    field('Starting gear', gear),
    field('Name (optional)', name),
    go,
  )
  handle.root.appendChild(wrap)

  return {
    apply(options) {
      if (!genre.options.length) {
        for (const key of options.genres) {
          const option = document.createElement('option')
          option.value = key
          option.textContent = GENRE_LABELS[key] ?? key
          genre.appendChild(option)
        }
      }
      genre.value = options.genre

      if (!persona.options.length) {
        const none = document.createElement('option')
        none.value = ''
        none.textContent = options.personas.length
          ? 'None — invent someone new'
          : 'No personas available'
        persona.appendChild(none)
        for (const entry of options.personas) {
          const option = document.createElement('option')
          option.value = entry.id
          option.textContent = entry.hasImage ? `${entry.name} (has image)` : entry.name
          persona.appendChild(option)
        }
      }

      archetype.textContent = ''
      for (const value of options.archetypes) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = value
        archetype.appendChild(option)
      }
      // Sentinels the prompt builder understands, offered after the presets.
      for (const [value, label] of [
        [CLASS_STORY, 'Let the story decide'],
        [CLASS_OTHER, 'Custom…'],
      ] as const) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = label
        archetype.appendChild(option)
      }
      classOtherField.hidden = archetype.value !== CLASS_OTHER
      // Without an archetype the engine throws rather than picking one.
      // The sentinels are always available, so there is always something to roll.
      go.disabled = false
    },
    close() {
      handle.dismiss()
    },
  }
}
