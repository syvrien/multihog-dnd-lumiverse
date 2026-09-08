/**
 * panel-controls.ts — make the rendered tracker cards interactive.
 *
 * `renderer.js` emits upstream's full set of controls: collapse chevrons, a
 * paged/full-list toggle, a detach button, a per-category cog, "Create PC
 * Card", archetype rollers, quickstart genre buttons. Upstream binds them in
 * `src/ui/panel/card-events.js` — 1,058 jQuery lines against SillyTavern's DOM,
 * which the port does not carry.
 *
 * Registering that as a no-op left every control visible and dead: a chevron
 * that does not collapse, a "Create PC Card" button that does nothing. So this
 * module does two things:
 *
 *   - binds the controls the port genuinely supports
 *   - **removes** the ones it does not, rather than leaving them there
 *
 * The removal matters more than the binding. A control that looks live and
 * isn't is a worse bug than a missing feature, because it reads as breakage
 * rather than as scope.
 */

import type { ToBackend } from '../shared/protocol'

/**
 * Controls with no implementation here, and why.
 *
 * When a subsystem lands, delete its entry and bind it instead.
 */
const UNSUPPORTED: Array<{ selector: string; reason: string }> = [
  { selector: '.rt-detach-btn', reason: 'detached panels have no Spindle equivalent' },
  { selector: '.rt-category-settings-btn', reason: 'the category editor is not ported' },
  { selector: '.rt-party-compact-btn', reason: 'party compact mode is not ported' },
  { selector: '.rt-cr-help-icon', reason: 'the creator help popups are not ported' },
]

/*
 * `.rt-random-char-btn` and `.rt-quickstart-genre-btn` were listed here too.
 * They never arrive: `renderMemoAsCards` emits them only for an *empty* memo,
 * and the backend does not call the renderer in that case — it sends
 * `memoPresent: false` and the frontend paints its own empty state. Rolling a
 * character is on the panel toolbar instead, where it is reachable with or
 * without a memo. Stripping selectors that never appear only made this list
 * read as a longer list of missing features than it is.
 */

/** Sections whose header should not collapse — they have no body to hide. */
const NO_COLLAPSE = new Set(['BENCHED PARTY'])

export function bindPanelControls(
  root: Element,
  send: (message: ToBackend) => void,
): void {
  // Player Card generation. The button lives in the CHARACTER card header.
  for (const button of root.querySelectorAll('.rt-char-to-persona-btn')) {
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      ;(button as HTMLButtonElement).disabled = true
      button.textContent = 'Creating…'
      send({ type: 'pc:generate' })
    })
  }

  // Strip first, so nothing dead survives even if binding below throws.
  for (const { selector } of UNSUPPORTED) {
    for (const element of root.querySelectorAll(selector)) element.remove()
  }

  // Collapse / expand. The whole header is the target, matching upstream —
  // the chevron is a small tap area on a phone.
  for (const header of root.querySelectorAll('.rt-section-header')) {
    const tag = header.getAttribute('data-tag')
    if (!tag || NO_COLLAPSE.has(tag)) continue

    const element = header as HTMLElement
    element.style.cursor = 'pointer'
    element.setAttribute('role', 'button')
    element.setAttribute('tabindex', '0')

    const toggle = (event: Event): void => {
      // Let the nested full-view button handle its own click.
      if ((event.target as Element | null)?.closest?.('button')) return
      event.preventDefault()
      send({ type: 'panel:toggle-section', tag })
    }

    element.addEventListener('click', toggle)
    element.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key
      if (key === 'Enter' || key === ' ') toggle(event)
    })
  }

  // Paged vs full list. The engine already supports this through
  // `uiOptions.fullViewSections`; only the click had to be carried across.
  for (const button of root.querySelectorAll('.rt-fullview-btn')) {
    const tag = button.getAttribute('data-tag')
    if (!tag) {
      button.remove()
      continue
    }
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      send({ type: 'panel:toggle-fullview', tag })
    })
  }
}

/** Exposed for tests: the controls this module deliberately removes. */
export function unsupportedSelectors(): string[] {
  return UNSUPPORTED.map(entry => entry.selector)
}
