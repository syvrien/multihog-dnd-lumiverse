/**
 * frontend.ts — the Spindle frontend entry.
 *
 * SillyTavern let the extension own a floating jQuery panel and a 2,300-line
 * settings document injected straight into the host page. Neither is available
 * here, so the UI is rebuilt on Spindle placements: a drawer tab holds the
 * tracker panel, and popups the engine opens from the backend are rendered with
 * the host's own modal chrome.
 *
 * The panel markup itself still comes from the ported `renderer.js` running on
 * the backend — it is DOM-free and produces an HTML string, which the host
 * sanitises through DOMPurify on injection.
 */

import { POPUP_RESULT, POPUP_TYPE, type ToBackend, type ToFrontend } from './shared/protocol'
import type { SpindleDrawerTabHandle, SpindleFrontendContext } from 'lumiverse-spindle-types'
import { ENGINE_CSS } from './engine/style-css'
import { bindPanelControls } from './ui/panel-controls'
import { installCyoa } from './ui/cyoa'
import { installSettings } from './ui/settings'
import { PLAYER_CARD_CSS, showPlayerCardPreview } from './ui/player-card'
import { ROLL_CSS, showRollPicker, type RollHandle } from './ui/roll-character'
import { ROLL_REVIEW_CSS, showRollReview, type RollReviewHandle } from './ui/roll-review'
import { PORTRAIT_CSS, bindPortraitBoxes, showPortraitPicker } from './ui/portrait'
import { COMPANION_CSS, installCompanion, type CompanionHandle } from './ui/companion'
import { RECORDS_CSS, installRecords, type RecordsHandle } from './ui/records'
import { WIZARD_CSS, showWizard, type WizardHandle } from './ui/wizard'
import { WORKSHOP_CSS, installWorkshop, type WorkshopHandle } from './ui/workshop'
import { NPC_LIBRARY_CSS } from './ui/npc-library'
import { QUICKSTART_CSS, showQuickStart, type QuickStartHandle } from './ui/quickstart'
import { capturePanelAnimations, playPanelAnimations } from './ui/animations'
import {
  PROMPT_DEFAULTS_CSS, showPromptDefaults, type PromptDefaultsHandle,
} from './ui/prompt-defaults'

const TAB_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">'
  + '<path d="M3 5.5 10 2l7 3.5v9L10 18l-7-3.5z"/><path d="M10 2v16M3 5.5l7 3.5 7-3.5"/></svg>'

const PANEL_CSS = `
/*
 * element.hidden works only because the user agent ships
 * [hidden] { display: none } -- and ANY author rule setting display beats it.
 * The rows below are flex containers, so without this they stayed on screen
 * with hidden faithfully set to true. Declared first so it covers every
 * toggled element in the panel.
 *
 * NOTE: this whole block is a JS template literal. A backtick here ends the
 * string and breaks the file.
 */
.dnd-panel [hidden] { display: none !important; }

.dnd-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.dnd-panel__toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dnd-panel__button {
  min-height: 32px; padding: 0 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-surface, transparent);
  color: var(--lumiverse-text, inherit); font: inherit;
}
.dnd-panel__button:hover { filter: brightness(1.12); }
.dnd-panel__empty {
  padding: 24px 12px; text-align: center; line-height: 1.5;
  color: var(--lumiverse-text-dim, rgba(128,128,128,.9));
}
.dnd-panel__empty-actions { display: flex; justify-content: center; margin-top: 14px; }
/* Ported cards can be wide; never let them push the drawer sideways. */
.dnd-panel__body { overflow-x: auto; }

/*
 * Upstream renders the tracker as a floating, draggable window:
 *
 *   .rpg-tracker-panel { position: fixed; top: 100px; right: 20px;
 *                        width: 300px; height: 420px; z-index: 2000 }
 *
 * That class also carries every --rt-* variable and scopes 109 rules, so it
 * cannot simply be dropped. Here the panel is drawer content, not a window, so
 * the placement is neutralised and the visual identity kept.
 *
 * position:relative rather than static -- the stylesheet paints background
 * images through .rt-has-bg-image::before/::after, which are absolutely
 * positioned and need this element as their containing block.
 *
 * The compound selector outranks the single-class rule, so this wins on
 * specificity rather than on injection order.
 */
.dnd-panel__body.rpg-tracker-panel {
  position: relative;
  inset: auto;
  width: 100%;
  height: auto;
  min-width: 0;
  min-height: 0;
  max-height: none;
  z-index: auto;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
  backdrop-filter: none;
  overflow: visible;
  /* The drawer scrolls; a nested scroller would trap the wheel. */
  overflow-y: visible;
}

.dnd-popup { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.dnd-popup__input {
  width: 100%; min-height: 96px; padding: 8px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px minimum or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-popup__actions { display: flex; gap: 8px; justify-content: flex-end; }
.dnd-popup__confirm { font-weight: 600; }

.dnd-panel__result {
  padding: 8px 10px; border-radius: 6px; line-height: 1.4;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  color: var(--lumiverse-text-dim, rgba(160,160,160,.95));
  overflow-wrap: anywhere;
}
.dnd-panel__result--warn { border-color: rgba(216,160,72,.55); }

.dnd-panel__ask { display: flex; gap: 8px; }
.dnd-panel__ask-input {
  flex: 1 1 auto; min-height: 34px; padding: 7px 9px; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  /* 16px or iOS Safari zooms the viewport on focus. */
  font: inherit; font-size: 16px;
}
.dnd-panel__editor { display: flex; flex-direction: column; gap: 8px; }
.dnd-panel__editor-actions { display: flex; gap: 8px; }
.dnd-panel__editor-text {
  width: 100%; min-height: 220px; padding: 8px; border-radius: 6px; resize: vertical;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.5;
  white-space: pre; overflow-wrap: normal; overflow-x: auto;
}
.dnd-panel__history {
  width: 100%; min-height: 32px; padding: 5px 8px; border-radius: 6px;
  border: 1px solid var(--lumiverse-border, rgba(128,128,128,.35));
  background: var(--lumiverse-bg, transparent);
  color: var(--lumiverse-text, inherit);
  font: inherit;
}
`

interface PanelRefs {
  body: HTMLElement
  status: HTMLElement
  result: HTMLElement
  /** Raw memo editor, hidden until opened. */
  editor: HTMLTextAreaElement
  editorWrap: HTMLElement
  ask: HTMLInputElement
  /** Fill the raw editor's "restore an earlier version" picker. */
  setHistory(entries: Array<{ label: string; text: string }>): void
}

function buildPanel(ctx: SpindleFrontendContext, tab: SpindleDrawerTabHandle): PanelRefs {
  const panel = ctx.dom.createElement('div', { class: 'dnd-panel' })

  const toolbar = ctx.dom.createElement('div', { class: 'dnd-panel__toolbar' })
  const refresh = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  refresh.textContent = 'Refresh'
  refresh.addEventListener('click', () => {
    send(ctx, { type: 'panel:refresh' })
  })
  const run = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  run.textContent = 'Update state'
  run.addEventListener('click', () => {
    send(ctx, { type: 'tracker:run' })
  })

  // The incremental pass only ever reads the last turn, so anything it missed
  // stays missed. This re-reads the whole campaign — one model call per chunk,
  // which is why it confirms rather than sitting next to Refresh unguarded.
  const audit = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  audit.textContent = 'Full audit'
  audit.title = 'Re-read the entire chat and rebuild the sheet. '
    + 'Several model calls on a long campaign.'
  audit.addEventListener('click', () => {
    const confirmed = globalThis.confirm?.(
      'Re-read the whole chat and rebuild the tracker sheet?\n\n'
      + 'This makes one model call per chunk of the conversation, so on a long '
      + 'campaign it takes a while and costs accordingly.',
    )
    if (confirmed === false) return
    send(ctx, { type: 'tracker:full-audit' })
  })

  // Ask the tracker to fix something in words rather than editing the memo by
  // hand. Both paths commit through the same merge as an automatic pass.
  const askRow = ctx.dom.createElement('div', { class: 'dnd-panel__ask' })
  askRow.hidden = true
  const ask = ctx.dom.createElement('input', {
    class: 'dnd-panel__ask-input',
    type: 'text',
    placeholder: 'Tell the tracker what to fix…',
  }) as HTMLInputElement
  const askSend = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  askSend.textContent = 'Send'
  const submitAsk = (): void => {
    const instruction = ask.value.trim()
    if (!instruction) return
    ask.value = ''
    // Collapse on send: the answer arrives in the result line and the cards.
    askRow.hidden = true
    send(ctx, { type: 'tracker:ask', instruction })
  }
  askSend.addEventListener('click', submitAsk)
  ask.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key
    if (key === 'Enter') submitAsk()
    if (key === 'Escape') askRow.hidden = true
  })
  askRow.append(ask, askSend)

  const editorWrap = ctx.dom.createElement('div', { class: 'dnd-panel__editor' })
  editorWrap.hidden = true

  // Every commit pushes the previous memo into `settings.memoHistory`, and
  // until now nothing read it — so a state pass that mangled the sheet was
  // unrecoverable. Restoring loads the old text into the box rather than
  // committing it, so there is still exactly one commit path.
  const history = ctx.dom.createElement('select', {
    class: 'dnd-panel__history',
    title: 'Load an earlier version into the editor',
  }) as HTMLSelectElement
  history.hidden = true

  const editor = ctx.dom.createElement('textarea', {
    class: 'dnd-panel__editor-text',
  }) as HTMLTextAreaElement
  editor.rows = 14
  let historyTexts: string[] = []
  history.addEventListener('change', () => {
    const index = Number(history.value)
    if (!Number.isInteger(index) || index < 0) return
    editor.value = historyTexts[index] ?? editor.value
    editor.focus()
  })
  const editorActions = ctx.dom.createElement('div', { class: 'dnd-panel__editor-actions' })
  const saveBtn = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  saveBtn.textContent = 'Save memo'
  saveBtn.addEventListener('click', () => {
    send(ctx, { type: 'memo:write', text: editor.value })
    editorWrap.hidden = true
  })
  const cancelBtn = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  cancelBtn.textContent = 'Cancel'
  cancelBtn.addEventListener('click', () => { editorWrap.hidden = true })
  editorActions.append(saveBtn, cancelBtn)
  editorWrap.append(history, editor, editorActions)

  // Both editors are opened from the toolbar and closed again on use, so the
  // cards sit directly under it instead of being pushed down by controls that
  // are idle most of the time.
  const askToggle = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  askToggle.textContent = 'Ask'
  askToggle.addEventListener('click', () => {
    editorWrap.hidden = true
    askRow.hidden = !askRow.hidden
    if (!askRow.hidden) ask.focus()
  })

  const roll = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  roll.textContent = 'Roll character'
  roll.addEventListener('click', () => {
    askRow.hidden = true
    editorWrap.hidden = true
    send(ctx, { type: 'roll:open' })
  })

  const edit = ctx.dom.createElement('button', { class: 'dnd-panel__button', type: 'button' })
  edit.textContent = 'Edit raw'
  edit.addEventListener('click', () => {
    askRow.hidden = true
    if (editorWrap.hidden) send(ctx, { type: 'memo:read' })
    else editorWrap.hidden = true
  })

  const status = ctx.dom.createElement('span', { class: 'dnd-panel__status' })
  toolbar.append(refresh, run, audit, askToggle, edit, roll, status)

  // Last-pass outcome. Kept above the cards so "nothing happened" is always
  // explained rather than left to the server log.
  const result = ctx.dom.createElement('div', { class: 'dnd-panel__result' })
  result.hidden = true

  const body = ctx.dom.createElement('div', { class: 'dnd-panel__body rpg-tracker-panel' })

  panel.append(toolbar, askRow, editorWrap, result, body)
  tab.root.appendChild(panel)
  return {
    body, status, result, editor, editorWrap, ask,
    setHistory(entries) {
      historyTexts = entries.map(entry => entry.text)
      history.textContent = ''
      // With nothing to restore the control is noise, so it stays away.
      history.hidden = entries.length === 0
      if (!entries.length) return

      const current = document.createElement('option')
      current.value = '-1'
      current.textContent = 'Current version'
      history.appendChild(current)
      entries.forEach((entry, index) => {
        const option = document.createElement('option')
        option.value = String(index)
        option.textContent = entry.label
        history.appendChild(option)
      })
      history.value = '-1'
    },
  }
}

function send(ctx: SpindleFrontendContext, message: ToBackend): void {
  ctx.sendToBackend(message)
}

/**
 * Render a popup the engine opened from the backend.
 *
 * `ctx.ui.showModal()` is not a "show a message and resolve with the answer"
 * helper: it returns synchronously with a handle whose `root` is an empty modal
 * body the extension owns entirely. The host draws the chrome — backdrop,
 * header, close button, Escape — and nothing else. So the SillyTavern popup
 * types have to be built here out of real elements.
 *
 * `callGenericPopup` is synchronous-looking on the engine side, so every path
 * out of here must post exactly one result — dismissal included — or the
 * backend promise hangs until its timeout.
 */
function showPopup(
  ctx: SpindleFrontendContext,
  message: Extract<ToFrontend, { type: 'popup:open' }>,
): void {
  let replied = false
  const reply = (result: unknown): void => {
    if (replied) return
    replied = true
    send(ctx, { type: 'popup:result', requestId: message.requestId, result })
  }

  let handle: { root: HTMLElement; dismiss(): void; onDismiss(h: () => void): () => void }
  try {
    handle = ctx.ui.showModal({
      title: (message.options?.title as string) ?? 'Multihog D&D',
    }) as typeof handle
  } catch (error) {
    // Modal cap reached or the frontend went inactive. Refusing is safer than
    // silently answering "yes" on the user's behalf.
    console.warn('[DnD] showModal failed:', error)
    reply(POPUP_RESULT.CANCELLED)
    return
  }

  // Dismissal (close button, backdrop, Escape) is a cancellation.
  handle.onDismiss(() => reply(POPUP_RESULT.CANCELLED))

  const body = document.createElement('div')
  body.className = 'dnd-popup'

  const content = ctx.dom.inject(body, message.content, 'beforeend')
  void content

  const isInput = message.popupType === POPUP_TYPE.INPUT
  const isConfirm = message.popupType === POPUP_TYPE.CONFIRM

  let input: HTMLTextAreaElement | null = null
  if (isInput) {
    input = document.createElement('textarea')
    input.className = 'dnd-popup__input'
    input.value = message.inputValue ?? ''
    input.rows = 4
    body.appendChild(input)
  }

  const actions = document.createElement('div')
  actions.className = 'dnd-popup__actions'

  const finish = (result: unknown): void => {
    reply(result)
    handle.dismiss()
  }

  /*
   * SillyTavern's popup options, honoured rather than dropped.
   *
   * `okButton` / `cancelButton` relabel the two standard buttons (or hide one,
   * given `false`), and `customButtons` adds more, each resolving to its own
   * `result`. The port rendered a fixed "OK / Cancel" and ignored all three, so
   * every engine popup asking "Restore or Overwrite?" read as "OK or Cancel?"
   * — and a three-way choice could not be offered at all.
   */
  const options = (message.options ?? {}) as {
    okButton?: string | boolean
    cancelButton?: string | boolean
    customButtons?: Array<string | { text?: string, result?: unknown }>
  }
  const button = (label: string, result: () => unknown, primary = false): void => {
    const element = document.createElement('button')
    element.className = primary ? 'dnd-panel__button dnd-popup__confirm' : 'dnd-panel__button'
    element.type = 'button'
    element.textContent = label
    element.addEventListener('click', () => finish(result()))
    actions.appendChild(element)
  }
  const labelFor = (option: string | boolean | undefined, fallback: string): string | null =>
    option === false ? null : (typeof option === 'string' && option.trim() ? option : fallback)

  if (isInput || isConfirm) {
    const cancelLabel = labelFor(options.cancelButton, 'Cancel')
    if (cancelLabel) button(cancelLabel, () => (isInput ? null : POPUP_RESULT.NEGATIVE))
  }
  for (const custom of Array.isArray(options.customButtons) ? options.customButtons : []) {
    const text = typeof custom === 'string' ? custom : String(custom?.text ?? '')
    if (!text.trim()) continue
    const result = typeof custom === 'string' ? POPUP_RESULT.CANCELLED : (custom?.result ?? null)
    button(text, () => result)
  }
  const okLabel = labelFor(options.okButton, isInput || isConfirm ? 'OK' : 'Close')
  if (okLabel) {
    button(okLabel, () => (
      // ST resolves INPUT popups with the typed string and the rest with a
      // POPUP_RESULT constant.
      isInput ? (input?.value ?? '') : POPUP_RESULT.AFFIRMATIVE
    ), true)
  }

  body.appendChild(actions)
  handle.root.appendChild(body)
  input?.focus()
}

export function setup(ctx: SpindleFrontendContext): () => void {
  // Upstream's stylesheet first, so the port's own rules can override it.
  const removeEngineStyle = ctx.dom.addStyle(ENGINE_CSS)
  const removeStyle = ctx.dom.addStyle(
    PANEL_CSS + PLAYER_CARD_CSS + ROLL_CSS + ROLL_REVIEW_CSS + PORTRAIT_CSS
    + COMPANION_CSS + RECORDS_CSS + WIZARD_CSS + WORKSHOP_CSS + NPC_LIBRARY_CSS
    + QUICKSTART_CSS + PROMPT_DEFAULTS_CSS,
  )

  const tab = ctx.ui.registerDrawerTab({
    id: 'tracker',
    title: 'D&D State Tracker',
    shortName: 'Tracker',
    description: 'Character sheet, party, inventory and quests tracked from the story',
    keywords: ['rpg', 'dnd', 'tracker', 'character', 'sheet', 'inventory', 'quests'],
    headerTitle: 'Tracker',
    iconSvg: TAB_ICON,
  })

  const refs = buildPanel(ctx, tab)
  // A regeneration reuses the open modal rather than stacking a second one —
  // the host caps an extension at two.
  let playerCard: { update(next: never): void } | null = null
  let rollPicker: RollHandle | null = null
  let quickStart: QuickStartHandle | null = null
  let promptDefaults: PromptDefaultsHandle | null = null
  let rollReview: RollReviewHandle | null = null
  let portraitPicker: { close(): void } | null = null
  let injected: Element | null = null

  /**
   * The last roll request, so "Roll again" can repeat the same choices without
   * reopening the picker.
   */
  let lastRoll: Extract<ToBackend, { type: 'roll:go' }> | null = null
  const sendRoll = (message: ToBackend): void => {
    if (message.type === 'roll:go') lastRoll = message
    send(ctx, message)
  }

  // Its own drawer tab: upstream floats it over the page, which has no
  // equivalent here and would fight the drawer for space anyway.
  const companion: CompanionHandle = installCompanion(ctx, message => send(ctx, message))
  const records: RecordsHandle = installRecords(ctx, message => send(ctx, message))
  let wizard: WizardHandle | null = null
  const workshop: WorkshopHandle = installWorkshop(ctx, message => send(ctx, message))

  // Clickable choices live in the chat messages, not the drawer.
  const cyoa = installCyoa(ctx, message => send(ctx, message))
  const settings = installSettings(ctx, message => send(ctx, message), TAB_ICON)

  const unsubscribe = ctx.onBackendMessage((raw: unknown) => {
    const message = raw as ToFrontend
    switch (message?.type) {
      case 'panel:render': {
        // Read the numbers that are on screen before they are thrown away.
        // Keyed on the chat, so a switch repaints without animating between
        // two campaigns' values.
        const animating = capturePanelAnimations(refs.body, String(message.chatId ?? ''))
        if (injected) {
          ctx.dom.uninject(injected)
          injected = null
        }
        refs.body.textContent = ''
        if (!message.memoPresent) {
          const empty = ctx.dom.createElement('div', { class: 'dnd-panel__empty' })
          empty.textContent = 'No campaign state yet. Start a scene and the tracker will fill in.'
          // An empty panel is exactly where onboarding belongs: it is the one
          // moment the answer to "now what?" is a character you do not have.
          const instant = ctx.dom.createElement('button', {
            class: 'dnd-panel__button', type: 'button',
          })
          instant.textContent = 'Instant Action'
          instant.title = 'Roll a character and start a story in one step.'
          instant.addEventListener('click', () => {
            quickStart?.close()
            quickStart = showQuickStart(ctx, m => send(ctx, m), () => { quickStart = null })
          })
          const row = ctx.dom.createElement('div', { class: 'dnd-panel__empty-actions' })
          row.appendChild(instant)
          empty.appendChild(row)
          refs.body.appendChild(empty)
          return
        }
        injected = ctx.dom.inject(refs.body, message.html, 'beforeend')
        // The rendered markup carries upstream's own controls. Wire the ones
        // that work here and remove the rest — a button that does nothing is
        // worse than no button.
        bindPanelControls(injected, message => send(ctx, message))
        // The portrait box carries a tooltip promising click and drop; this is
        // what makes that true.
        bindPortraitBoxes(injected, message => send(ctx, message))
        // Last, on the markup that is now on screen: XP counts down out of the
        // floater, and a stat bar that moved trickles rather than jumping.
        playPanelAnimations(refs.body, animating)
        break
      }
      case 'settings:sync':
        settings.apply(message.settings, message.connections)
        break
      case 'companion:state':
        companion.apply(message)
        break
      case 'sysprompt:sections':
        settings.applySections(message)
        break
      case 'modules:state':
        settings.applyModules(message)
        break
      case 'cartridge:state':
        settings.applyCartridges(message)
        break
      case 'cartridge:detail':
        settings.applyCartridgeDetail(message)
        break
      case 'cartridge:exported':
        settings.applyCartridgeExport(message)
        break
      case 'theme:state':
        settings.applyTheme(message)
        break
      case 'theme:draft':
        settings.applyThemeDraft(message)
        break
      case 'portrait:gen-state':
        settings.applyPortraitGen(message)
        break
      case 'portrait:gen-result':
        settings.applyPortraitResult(message)
        break
      case 'records:state':
        records.apply(message)
        break
      case 'scene:view':
        workshop.applyScene(message)
        break
      case 'maps:list':
        workshop.applyMaps(message)
        break
      case 'maps:render':
        workshop.applyMap(message)
        break
      case 'maps:draft':
        workshop.applyMapDraft(message)
        break
      case 'maps:saved':
        workshop.applyMapSaved(message)
        break
      case 'maps:export':
        workshop.applyMapExport(message)
        break
      case 'agent:view':
        workshop.applyAgent(message)
        break
      case 'terminal:result':
        workshop.applyTerminal(message)
        break
      case 'records:entry':
        records.applyEntry(message)
        break
      case 'npc:library':
        records.applyLibrary(message)
        break
      case 'npc:exported':
        records.applyExport(message)
        break
      case 'wizard:examples':
        // The first `wizard:open` opens the modal; the examples that come back
        // fill it. A second one while it is already open just refills.
        if (!wizard) {
          wizard = showWizard(ctx, m => send(ctx, m), () => { wizard = null })
        }
        wizard?.applyExamples(message)
        break
      case 'wizard:draft':
        wizard?.applyDraft(message)
        break
      case 'groups:state':
        settings.applyGroups(message)
        break
      case 'blocks:state':
        settings.applyBlocks(message)
        break
      case 'sections:state':
        settings.applyCardSections(message)
        break
      case 'cortex:state':
        settings.applyCortex(message)
        break
      case 'cortex:synced':
        settings.applyCortexSynced(message)
        break
      case 'prompts:changed':
        // Only when something actually changed — the backend acknowledges the
        // silent cases itself and reports pending:false.
        if (message.pending && message.changed.length) {
          promptDefaults?.close()
          promptDefaults = showPromptDefaults(ctx, message, m => send(ctx, m), () => {
            promptDefaults = null
          })
        }
        break
      case 'prompts:applied':
        if (message.applied.length) {
          console.info(`[DnD] prompt defaults updated: ${message.applied.join(', ')}`)
        }
        break
      case 'quickstart:name':
        quickStart?.applyName(message.name)
        break
      case 'quickstart:step':
        quickStart?.applyStep(message.label)
        break
      case 'quickstart:done':
        quickStart?.applyDone(message)
        break
      case 'roll:options': {
        // The picker asks again when the genre changes, so reuse it if open.
        if (!rollPicker) {
          rollPicker = showRollPicker(ctx, sendRoll, () => { rollPicker = null })
        }
        rollPicker?.apply(message)
        break
      }
      case 'portrait:options': {
        // Only one at a time: a second click while the first is open would
        // stack modals, and the host caps an extension at two.
        portraitPicker?.close()
        portraitPicker = showPortraitPicker(ctx, message, m => send(ctx, m), () => {
          portraitPicker = null
        })
        break
      }
      case 'roll:draft': {
        // A reroll goes back into the open review rather than stacking one.
        if (rollReview) {
          rollReview.update(message)
          break
        }
        if (!message.ok) {
          refs.result.hidden = false
          refs.result.classList.add('dnd-panel__result--warn')
          refs.result.textContent =
            `Nothing rolled${message.reason ? ` — ${message.reason}` : ''}.`
          break
        }
        rollReview = showRollReview(
          ctx,
          message,
          m => send(ctx, m),
          () => { if (lastRoll) send(ctx, lastRoll) },
          () => { rollReview = null },
        )
        if (!rollReview) {
          // No modal host means no review, and committing unseen is exactly
          // what this change exists to prevent.
          refs.result.hidden = false
          refs.result.classList.add('dnd-panel__result--warn')
          refs.result.textContent = 'Rolled a character, but the review could not open.'
        }
        break
      }
      case 'pc:preview': {
        if (playerCard) {
          playerCard.update(message as never)
          break
        }
        if (!message.ok) {
          refs.result.hidden = false
          refs.result.classList.add('dnd-panel__result--warn')
          refs.result.textContent = `Player Card not created${message.reason ? ` — ${message.reason}` : ''}.`
          send(ctx, { type: 'panel:refresh' })
          break
        }
        playerCard = showPlayerCardPreview(ctx, message, m => send(ctx, m), () => {
          playerCard = null
        })
        // The button in the card header is left disabled while generating, so
        // repaint once the modal is up (or failed to open).
        send(ctx, { type: 'panel:refresh' })
        break
      }
      case 'memo:content':
        refs.editor.value = message.text
        refs.setHistory(message.history ?? [])
        refs.editorWrap.hidden = false
        refs.editor.focus()
        break
      case 'panel:status':
        refs.status.textContent = message.running ? (message.label ?? 'Working…') : ''
        break
      case 'panel:result': {
        const time = new Date(message.at).toLocaleTimeString()
        refs.result.hidden = false
        refs.result.classList.toggle('dnd-panel__result--warn', !message.changed)
        refs.result.textContent = message.changed
          ? `Updated at ${time}.`
          : `No update at ${time}${message.reason ? ` — ${message.reason}` : ''}.`
        break
      }
      case 'popup:open':
        showPopup(ctx, message)
        break
      case 'toast':
        break
      default:
        break
    }
  })

  tab.onActivate(() => send(ctx, { type: 'panel:refresh' }))
  // Every initial request goes out here, after `onBackendMessage` above is
  // listening. A panel that asks while it is being constructed can have its
  // reply delivered before the handler exists, and the panel then sits empty
  // until something else happens to repaint it.
  send(ctx, { type: 'panel:ready' })
  send(ctx, { type: 'settings:get' })
  send(ctx, { type: 'sysprompt:read' })
  send(ctx, { type: 'modules:read' })
  send(ctx, { type: 'records:read' })
  send(ctx, { type: 'scene:read' })
  send(ctx, { type: 'maps:list' })
  send(ctx, { type: 'agent:read' })
  send(ctx, { type: 'npc:read' })
  send(ctx, { type: 'cartridge:read' })
  send(ctx, { type: 'groups:read' })
  send(ctx, { type: 'blocks:read' })
  send(ctx, { type: 'sections:read', target: 'npc' })
  send(ctx, { type: 'cortex:read' })
  // Last: it can open a dialog, and it should not land on top of a panel that
  // is still filling in.
  send(ctx, { type: 'prompts:check' })
  send(ctx, { type: 'theme:read' })
  send(ctx, { type: 'portrait:gen-read' })
  send(ctx, { type: 'companion:read' })

  return () => {
    unsubscribe()
    rollPicker?.close()
    rollReview?.close()
    portraitPicker?.close()
    companion.dispose()
    records.dispose()
    workshop.dispose()
    wizard?.close()
    settings.dispose()
    cyoa.dispose()
    if (injected) ctx.dom.uninject(injected)
    tab.destroy()
    removeStyle()
    removeEngineStyle()
    ctx.dom.cleanup()
  }
}
