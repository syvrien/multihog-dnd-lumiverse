/**
 * frontend.ts — exercise the frontend module under a real DOM.
 *
 *   bun tests/frontend.ts
 *
 * The host loader swallows a throwing `setup()` into a single
 * `console.error('[Spindle] Failed to load frontend after enable:', err)`, so a
 * broken frontend looks exactly like a frontend that was never loaded: no
 * drawer tab, no error anywhere the user would think to look. This runs the
 * real bundle against a stubbed context so that failure mode is a failing test
 * instead of a silent absence.
 */

import { Window } from 'happy-dom'
import { SETTINGS_SCHEMA } from '../src/shared/settings-schema'

const window = new Window({ url: 'http://localhost:7860' })
// The module builds elements directly, so the globals must exist before import.
const g = globalThis as Record<string, unknown>
g.window = window
g.document = window.document
g.HTMLElement = window.HTMLElement
g.Element = window.Element
g.Node = window.Node
g.CustomEvent = window.CustomEvent

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const calls: string[] = []
const sent: Array<Record<string, unknown>> = []
const doc = window.document
const stage = doc.createElement('div')
doc.body.appendChild(stage)

let backendHandler: ((payload: unknown) => void) | undefined
/** The chat this fake tab shows, as `ctx.getActiveChat()` reports it. */
let viewing: string | null = 'chat-on-screen'
const eventHandlers = new Map<string, (payload: unknown) => void>()
const tagHandlers = new Map<string, (payload: Record<string, unknown>) => void>()
const messageBubbles = new Map<string, Element>()

/** Mirrors the real SpindleFrontendContext closely enough to catch misuse. */
const ctx = {
  dom: {
    inject(target: unknown, html: string, position?: string) {
      calls.push('dom.inject')
      const wrapper = doc.createElement('div')
      wrapper.innerHTML = html
      const host = typeof target === 'string' ? doc.querySelector(target) : target as any
      if (!host) throw new Error(`inject target not found: ${String(target)}`)
      host.appendChild(wrapper)
      void position
      return wrapper
    },
    uninject(element: any) { calls.push('dom.uninject'); element?.remove?.() },
    addStyle(css: string) {
      calls.push('dom.addStyle')
      const style = doc.createElement('style')
      style.textContent = css
      doc.head.appendChild(style)
      return () => style.remove()
    },
    findMessageElement(messageId: string) {
      calls.push(`dom.findMessageElement:${messageId}`)
      return messageBubbles.get(messageId) ?? null
    },
    createElement(tag: string, attrs?: Record<string, string>) {
      calls.push(`dom.createElement:${tag}`)
      const el = doc.createElement(tag)
      for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v)
      return el
    },
    cleanup() { calls.push('dom.cleanup') },
  },
  ui: {
    registerDrawerTab(options: Record<string, unknown>) {
      calls.push(`ui.registerDrawerTab:${options.id}`)
      const root = doc.createElement('div')
      stage.appendChild(root)
      return {
        root, tabId: String(options.id),
        setTitle() {}, setShortName() {}, setBadge() {}, activate() {},
        destroy() { calls.push('tab.destroy') },
        onActivate() { calls.push('tab.onActivate'); return () => {} },
      }
    },
    // Present at runtime but absent from the published types — the settings
    // surface must use it when available and fall back when it is not.
    registerSettingsTab(options: Record<string, unknown>) {
      calls.push(`ui.registerSettingsTab:${options.id}`)
      const root = doc.createElement('div')
      stage.appendChild(root)
      return { root, destroy() { calls.push('settingsTab.destroy') } }
    },
    // Synchronous, returns a handle whose `root` the extension owns.
    showModal(options: Record<string, unknown>) {
      calls.push('ui.showModal')
      const root = doc.createElement('div')
      stage.appendChild(root)
      return {
        root,
        dismiss() { calls.push('modal.dismiss') },
        onDismiss() { calls.push('modal.onDismiss'); return () => {} },
      }
    },
  },
  events: {
    on(event: string, handler: (payload: unknown) => void) {
      eventHandlers.set(event, handler)
      return () => { eventHandlers.delete(event) }
    },
    emit() {},
  },
  getActiveChat() { return { chatId: viewing, characterId: null } },
  messages: {
    registerTagInterceptor(
      options: { tagName: string },
      handler: (payload: Record<string, unknown>) => void,
    ) {
      calls.push(`messages.registerTagInterceptor:${options.tagName}`)
      tagHandlers.set(options.tagName, handler)
      return () => { tagHandlers.delete(options.tagName) }
    },
    renderWidget() { return () => {} },
    removeWidget() {},
    getLatestMessageId() { return 'msg-1' },
  },
  sendToBackend(payload: Record<string, unknown>) {
    calls.push(`sendToBackend:${payload?.type}`)
    sent.push(payload)
  },
  onBackendMessage(handler: (payload: unknown) => void) {
    calls.push('onBackendMessage')
    backendHandler = handler
    return () => { backendHandler = undefined }
  },
}

console.log('── setup ──')
const { setup } = await import('../src/frontend')

let teardown: (() => void) | undefined
try {
  teardown = setup(ctx as never)
  check('setup() did not throw', true)
} catch (error) {
  check('setup() did not throw', false, (error as Error).stack ?? String(error))
}

check('registered the drawer tab', calls.some(c => c.startsWith('ui.registerDrawerTab')))

// Panels are built before `onBackendMessage` is registered, so anything asked
// for during construction can be answered before there is a listener — and the
// reply is dropped, leaving that panel blank until something else repaints it.
// Every initial request must come after the handler.
const listenerAt = calls.indexOf('onBackendMessage')
const firstRequestAt = calls.findIndex(c => c.startsWith('sendToBackend:'))
check('nothing is requested before the handler is listening',
  listenerAt !== -1 && (firstRequestAt === -1 || firstRequestAt > listenerAt),
  `handler at ${listenerAt}, first request at ${firstRequestAt}`
  + ` (${calls.filter(c => c.startsWith('sendToBackend:')).slice(0, 3).join(', ')})`)

// Upstream's stylesheet is declared in SillyTavern's manifest, not imported by
// any module, so the port script's import walk misses it. Without it the
// renderer emits correct markup that paints as unstyled text and collapsing
// does nothing, because the rule that hides a collapsed body lives there.
const styleText = [...doc.head.querySelectorAll('style')].map(s => s.textContent).join('\n')
check('injected the engine stylesheet', styleText.includes('.rpg-tracker-panel'),
  `${styleText.length} chars of CSS`)
check('carries the rule that hides a collapsed body',
  styleText.includes('.rt-collapsed .rt-section-body'))
check('defines the --rt-* theme variables', styleText.includes('--rt-accent'))

// Upstream renders the tracker as a fixed, 300x420 floating window. Inside a
// drawer that overlaps the toolbar and clips the content, so the placement is
// overridden while the visual identity is kept.
check('upstream still declares the floating window',
  styleText.includes('position: fixed'),
  'the engine stylesheet should be injected unmodified')
check('panel placement is neutralised for the drawer',
  styleText.includes('.dnd-panel__body.rpg-tracker-panel'),
  'override rule missing')

// The override must outrank the single-class rule on specificity, not on
// injection order, so it survives a change in style ordering.
const overrideAt = styleText.indexOf('.dnd-panel__body.rpg-tracker-panel')
check('override uses a compound selector', overrideAt !== -1
  && styleText.slice(overrideAt, overrideAt + 400).includes('position: relative'),
  'should set position:relative, not static')
check('told the backend it is ready', sent.some(m => m.type === 'panel:ready'))

console.log('\n── backend messages ──')
const drive = (label: string, payload: Record<string, unknown>): void => {
  try {
    backendHandler?.(payload)
    check(label, true)
  } catch (error) {
    check(label, false, (error as Error).message)
  }
}

drive('panel:render (empty state)', { type: 'panel:render', html: '', memoPresent: false })
drive('panel:render (card markup)', {
  type: 'panel:render',
  html: '<div class="rt-card"><span>Kestrel</span></div>',
  memoPresent: true,
})
check('card markup reached the panel', doc.body.innerHTML.includes('Kestrel'))

drive('panel:status', { type: 'panel:status', running: true, label: 'Working' })
drive('popup:open (input)', {
  type: 'popup:open', requestId: 'r1', popupType: 3,
  content: '<p>Name?</p>', inputValue: 'Kestrel', options: {},
})
check('popup rendered into the modal root', doc.body.innerHTML.includes('dnd-popup'))

drive('unknown message type is ignored', { type: 'something:new' })

console.log('\n── panel chrome ──')
// The editors are opened from the toolbar and close again on use, so the cards
// sit directly under it rather than being pushed down by idle controls.
const askRow = doc.querySelector('.dnd-panel__ask') as HTMLElement | null
const editorWrap = doc.querySelector('.dnd-panel__editor') as HTMLElement | null
check('ask row starts collapsed', askRow?.hidden === true, String(askRow?.hidden))
check('raw editor starts collapsed', editorWrap?.hidden === true, String(editorWrap?.hidden))

// Asserting `.hidden` alone is not enough: these rows are flex containers, and
// an author `display: flex` overrides the user agent's `[hidden] { display: none }`,
// so they stayed on screen with `hidden` set. The stylesheet has to force it.
check('stylesheet actually hides [hidden] elements',
  styleText.includes('.dnd-panel [hidden]') && /\.dnd-panel \[hidden\][^}]*display:\s*none/.test(styleText),
  'author display rules beat the UA [hidden] rule without this')

const toolbarButtons = [...doc.querySelectorAll('.dnd-panel__toolbar .dnd-panel__button')]
  .map(b => b.textContent)
check('toolbar exposes both editors',
  toolbarButtons.includes('Ask') && toolbarButtons.includes('Edit raw'),
  toolbarButtons.join(', '))

const askToggle = [...doc.querySelectorAll('.dnd-panel__button')]
  .find(b => b.textContent === 'Ask') as HTMLElement | undefined
askToggle?.click()
check('Ask reveals the input', askRow?.hidden === false, String(askRow?.hidden))

const askInput = doc.querySelector('.dnd-panel__ask-input') as HTMLInputElement | null
if (askInput) {
  askInput.value = 'Kestrel has 12 HP'
  const beforeAsk = sent.length
  ;(doc.querySelector('.dnd-panel__ask .dnd-panel__button') as HTMLElement | null)?.click()
  const asked = sent[sent.length - 1] as { type?: string; instruction?: string }
  check('Send dispatches the instruction',
    sent.length > beforeAsk && asked?.type === 'tracker:ask'
      && asked?.instruction === 'Kestrel has 12 HP',
    String(asked?.type))
  check('ask row collapses again after sending', askRow?.hidden === true,
    'it should not keep taking a row')
}

// Opening one editor closes the other, so they never stack.
askToggle?.click()
const editToggle = [...doc.querySelectorAll('.dnd-panel__button')]
  .find(b => b.textContent === 'Edit raw') as HTMLElement | undefined
editToggle?.click()
check('opening the raw editor closes the ask row', askRow?.hidden === true)

console.log('\n── panel controls ──')
// The rendered markup carries upstream's controls. The port binds what it
// supports and removes what it does not — a dead button reads as breakage.
drive('panel:render (upstream card markup)', {
  type: 'panel:render',
  memoPresent: true,
  html: `<div class="rt-section-card" data-tag="CHARACTER">
    <div class="rt-section-header" data-tag="CHARACTER">
      <span>CHARACTER</span>
      <div class="rt-section-header-right">
        <button class="rt-char-to-persona-btn" data-tag="CHARACTER">Create PC Card</button>
        <button class="rt-detach-btn" data-tag="CHARACTER">detach</button>
        <button class="rt-fullview-btn" data-tag="CHARACTER">full</button>
        <span class="rt-collapse-icon">&#9662;</span>
      </div>
    </div>
    <div class="rt-section-body">Syg (Seeker Student)</div>
  </div>`,
})

check('panel body carries the stylesheet scope class',
  !!doc.querySelector('.dnd-panel__body.rpg-tracker-panel'),
  'the stylesheet scopes 109 rules under .rpg-tracker-panel')
check('rendered the card', !!doc.querySelector('.rt-section-card'))
// Implemented now, so it must survive the strip and be wired.
const pcButton = doc.querySelector('.rt-char-to-persona-btn') as HTMLButtonElement | null
check('kept "Create PC Card"', !!pcButton)
if (pcButton) {
  const beforePc = sent.length
  pcButton.click()
  const asked = sent[sent.length - 1] as { type?: string }
  check('Create PC Card asks the backend to generate',
    sent.length > beforePc && asked?.type === 'pc:generate', String(asked?.type))
  check('button shows progress while generating',
    pcButton.disabled && (pcButton.textContent ?? '').includes('Creating'),
    pcButton.textContent ?? '')
}
check('removed the detach button', !doc.querySelector('.rt-detach-btn'))
check('kept the full-view toggle', !!doc.querySelector('.rt-fullview-btn'))
check('kept the card body', doc.body.textContent?.includes('Seeker Student') ?? false)

const header = doc.querySelector('.rt-section-header') as HTMLElement | null
check('header is focusable and marked as a button',
  header?.getAttribute('role') === 'button' && header?.getAttribute('tabindex') === '0')

let sentBefore = sent.length
header?.click()
let lastSent = sent[sent.length - 1] as { type?: string; tag?: string }
check('header click asks the backend to collapse',
  sent.length > sentBefore && lastSent?.type === 'panel:toggle-section'
    && lastSent?.tag === 'CHARACTER',
  `${lastSent?.type} ${lastSent?.tag}`)

sentBefore = sent.length
;(doc.querySelector('.rt-fullview-btn') as HTMLElement | null)?.click()
lastSent = sent[sent.length - 1] as { type?: string; tag?: string }
check('full-view button toggles rendering, not collapse',
  lastSent?.type === 'panel:toggle-fullview' && lastSent?.tag === 'CHARACTER',
  String(lastSent?.type))

console.log('\n── settings ──')
check('used the host settings tab',
  calls.includes('ui.registerSettingsTab:multihog_dnd'))
check('asked the backend for settings', sent.some(m => m.type === 'settings:get'))

drive('settings:sync', {
  type: 'settings:sync',
  settings: {
    enabled: true,
    connectionProfileId: 'conn-1',
    syspromptModules: { loot: true, quests: true },
  },
  connections: [{ id: 'conn-1', name: 'nano' }, { id: 'conn-2', name: 'big' }],
})

const settingsRoot = doc.querySelector('.dnd-settings')
check('rendered the settings form', !!settingsRoot)
// By name, not by count: a bare number breaks every time a section is added
// and says nothing about which one went missing.
const headings = [...(settingsRoot?.querySelectorAll('.dnd-settings__heading') ?? [])]
  .map(node => node.textContent)
const expectedSections = SETTINGS_SCHEMA.map(section => section.title)
check('rendered every schema section',
  expectedSections.every(title => headings.includes(title)),
  `missing: ${expectedSections.filter(t => !headings.includes(t)).join(', ') || 'none'}`)
check('plus the runtime-driven ruleset section',
  headings.includes('Narrator ruleset'), headings.join(', '))

// Groups are collapsible so thefrequently changed settings stay in front and the rest
// is one click away. Every grouped field must still be reachable and bound.
const groups = [...(settingsRoot?.querySelectorAll('.dnd-settings__group') ?? [])]
const groupTitles = groups.map(g => g.querySelector('.dnd-settings__summary')?.textContent)
const expectedGroups = SETTINGS_SCHEMA.flatMap(s => (s.groups ?? []).map(g => g.title))
check('rendered every group',
  expectedGroups.every(title => groupTitles.includes(title)),
  `missing: ${expectedGroups.filter(t => !groupTitles.includes(t)).join(', ') || 'none'}`)
check('every grouped field has a control',
  groups.every(g => g.querySelectorAll('.dnd-settings__field').length > 0),
  groupTitles.join(', '))

// All nine per-feature connections belong on one page, because they all inherit
// from the first and that is invisible if they are scattered.
const connectionSection = [...(settingsRoot?.querySelectorAll('.dnd-settings__section') ?? [])]
  .find(s => s.querySelector('.dnd-settings__heading')?.textContent === 'Connections')
check('gathered the connections in one place',
  (connectionSection?.querySelectorAll('select').length ?? 0) >= 8,
  String(connectionSection?.querySelectorAll('select').length))

/** By label — "the first select on the page" moves whenever sections do. */
const selectFor = (label: string): HTMLSelectElement | undefined =>
  [...(settingsRoot?.querySelectorAll('select') ?? [])].find(select =>
    select.closest('.dnd-settings__field')
      ?.querySelector('.dnd-settings__label > span')?.textContent === label) as
      HTMLSelectElement | undefined

const connectionSelect = selectFor('State Tracker') ?? null
check('populated the connection picker',
  (connectionSelect?.options.length ?? 0) === 3, // placeholder + two profiles
  String(connectionSelect?.options.length))
check('preselected the configured connection',
  connectionSelect?.value === 'conn-1', String(connectionSelect?.value))

// Toggling a grouped module must patch the dotted path, not a literal key.
const lootToggle = [...(settingsRoot?.querySelectorAll('input[type="checkbox"]') ?? [])]
  .find(input => {
    const row = input.closest('.dnd-settings__field')
    return row?.textContent?.includes('Loot')
  }) as HTMLInputElement | undefined

if (!lootToggle) {
  check('found the Loot toggle', false)
} else {
  const before = sent.length
  lootToggle.checked = false
  lootToggle.dispatchEvent(new window.Event('change', { bubbles: true }))
  const patch = sent[sent.length - 1] as { type?: string; patch?: Record<string, unknown> }
  check('toggle sent a settings patch',
    sent.length > before && patch?.type === 'settings:patch', String(patch?.type))
  check('patched the dotted path',
    Object.keys(patch?.patch ?? {})[0] === 'syspromptModules.loot',
    Object.keys(patch?.patch ?? {}).join(', '))
  check('patched the new value', patch?.patch?.['syspromptModules.loot'] === false,
    String(patch?.patch?.['syspromptModules.loot']))
}

// Changing the connection must also pin the source, or the engine ignores it.
if (connectionSelect) {
  connectionSelect.value = 'conn-2'
  connectionSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  const patch = sent[sent.length - 1] as { patch?: Record<string, unknown> }
  check('connection change sets source to profile',
    patch?.patch?.connectionSource === 'profile'
      && patch?.patch?.connectionProfileId === 'conn-2',
    JSON.stringify(patch?.patch))
}

// There is a second connection field now (the Map Architect). Each must set
// *its own* source key. Hard-coding the tracker's meant picking a Map Architect
// connection flipped the tracker's source and left the map's alone, so the
// engine ignored the profile and the pick silently did nothing.
const mapSelect = selectFor('Map Architect')

if (!mapSelect) {
  check('found the Map Architect connection picker', false)
} else {
  mapSelect.value = 'conn-2'
  mapSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  const patch = (sent[sent.length - 1] as { patch?: Record<string, unknown> })?.patch ?? {}
  check('the map picker sets the map source key',
    patch.mapArchitectConnectionSource === 'profile'
      && patch.mapArchitectConnectionProfileId === 'conn-2',
    JSON.stringify(patch))
  check('and leaves the tracker\'s connection alone',
    !('connectionSource' in patch) && !('connectionProfileId' in patch),
    JSON.stringify(patch))
}

console.log('\n── CYOA choices ──')
const bubble = doc.createElement('div')
messageBubbles.set('msg-1', bubble)
stage.appendChild(bubble)

check('registered a <choices> tag interceptor',
  calls.includes('messages.registerTagInterceptor:choices'))

const choicesHandler = tagHandlers.get('choices')
const CHOICES = [
  '<button>1. Clasp Tiktik’s hand — [Persuasion (untrained) DC 12]</button>',
  '<button>2. Study the assignment boards</button>',
].join('\n')

if (!choicesHandler) {
  check('choices handler available', false)
} else {
  // Mid-stream the block is incomplete and must be ignored.
  choicesHandler({ content: CHOICES, messageId: 'msg-1', isStreaming: true })
  check('ignores the block while streaming',
    bubble.querySelectorAll('button').length === 0,
    `${bubble.querySelectorAll('button').length} button(s)`)

  choicesHandler({ content: CHOICES, messageId: 'msg-1', isStreaming: false })
  const buttons = [...bubble.querySelectorAll('button')]
  check('rendered one button per choice', buttons.length === 2, String(buttons.length))
  check('kept the choice text', bubble.textContent?.includes('Clasp Tiktik') ?? false)
  check('split the mechanic into its own chip',
    bubble.querySelector('.dnd-cyoa__mech')?.textContent === 'Persuasion (untrained) DC 12',
    bubble.querySelector('.dnd-cyoa__mech')?.textContent ?? 'no chip')

  const before = sent.length
  ;(buttons[0] as HTMLButtonElement).click()
  const choice = sent[sent.length - 1]
  check('click sent the choice to the backend',
    sent.length > before && choice?.type === 'cyoa:choose', String(choice?.type))
  check('sent the original line, mechanics included',
    String(choice?.text ?? '').includes('Clasp Tiktik')
      && String(choice?.text ?? '').includes('[Persuasion (untrained) DC 12]'),
    String(choice?.text ?? '').slice(0, 70))
  check('disabled the block after choosing',
    buttons.every(b => (b as HTMLButtonElement).disabled))

  // An edit or swipe re-fires the interceptor; it must replace, not stack.
  choicesHandler({ content: CHOICES, messageId: 'msg-1', isStreaming: false })
  check('re-render replaces instead of stacking',
    bubble.querySelectorAll('button').length === 2,
    `${bubble.querySelectorAll('button').length} button(s)`)
}

console.log('\n── the narrator ruleset ──')
check('asked the backend for the ruleset sections',
  sent.some(m => m.type === 'sysprompt:read'))

drive('sysprompt:sections', {
  type: 'sysprompt:sections',
  sections: [
    { key: 'base:role', tag: 'role', label: 'role', enabled: true, kind: 'base' },
    { key: 'base:quests', tag: 'quests', label: 'quests', enabled: true, kind: 'base' },
    { key: 'lib:1', tag: 'hunger', label: 'hunger', enabled: false, kind: 'wizard' },
  ],
  systems: [{ id: 'gs-1', name: 'Hunger', enabled: true, description: 'Tracks hunger' }],
  size: 25771,
})

const crRows = [...doc.querySelectorAll('.dnd-cr__row')]
check('listed the sections', crRows.length >= 3, String(crRows.length))
// The ruleset is ~25 KB of every prompt; a user switching parts off is usually
// doing it to get that number down, so the number has to be on screen.
check('showed what it costs',
  (doc.querySelector('.dnd-cr__size')?.textContent ?? '').includes('25.8'),
  doc.querySelector('.dnd-cr__size')?.textContent ?? '')
check('marked a custom section as custom',
  [...doc.querySelectorAll('.dnd-cr__badge')].some(b => b.textContent === 'custom'))

const questsRow = crRows.find(r => r.textContent?.includes('quests'))
const questsBox = questsRow?.querySelector('input') as HTMLInputElement | null
if (!questsBox) {
  check('found the quests row', false)
} else {
  const beforeToggle = sent.length
  questsBox.checked = false
  questsBox.dispatchEvent(new window.Event('change', { bubbles: true }))
  const toggled = sent[sent.length - 1] as { type?: string; tag?: string; enabled?: boolean }
  check('toggling a section tells the backend',
    sent.length > beforeToggle && toggled?.type === 'sysprompt:toggle'
      && toggled?.tag === 'quests' && toggled?.enabled === false,
    `${toggled?.type} ${toggled?.tag}=${toggled?.enabled}`)
}

console.log('\n── campaign records ──')
check('registered its own drawer tab',
  calls.includes('ui.registerDrawerTab:records'))

drive('records:state', {
  type: 'records:state',
  ok: true,
  prefix: 'chat_1',
  totalTokens: 4200,
  groups: [
    {
      id: 'npc', label: 'People', count: 2, tokens: 3100, active: 1,
      entries: [
        {
          id: 'chat_1_NPCs::0', label: 'Bram', preview: 'An innkeeper.',
          keys: ['bram'], active: true, pinned: false, tokens: 1600, hasMap: false,
        },
        {
          id: 'chat_1_NPCs::1', label: 'Alia', preview: 'A courier.',
          keys: ['alia'], active: false, pinned: false, tokens: 1500, hasMap: false,
        },
      ],
    },
    { id: 'loc', label: 'Places', count: 0, tokens: 0, active: 0, entries: [] },
  ],
  player: { name: 'Syg', bio: 'A resonator.', portrait: '/api/v1/images/img-1' },
})

check('listed the group with entries',
  doc.querySelectorAll('.dnd-rec__group').length === 1,
  String(doc.querySelectorAll('.dnd-rec__group').length))
check('left the empty group out',
  !(doc.querySelector('.dnd-rec__summary')?.textContent ?? '').includes('Places'))
// Active entries ride along in every prompt, which is the number people act on.
check('showed the cost and how many are in the prompt',
  /2 · 1 active · ~3\.1k/.test(doc.querySelector('.dnd-rec__count')?.textContent ?? ''),
  doc.querySelector('.dnd-rec__count')?.textContent ?? '')
check('showed the player card', (doc.querySelector('.dnd-rec__pc-name')?.textContent) === 'Syg')

const recEntry = doc.querySelector('.dnd-rec__entry') as HTMLElement | null
if (!recEntry) {
  check('rendered an entry', false)
} else {
  const beforeOpen = sent.length
  recEntry.click()
  const opened = sent[sent.length - 1] as { type?: string; id?: string }
  // The whole encyclopedia is too much to push just because a tab opened.
  check('opening one fetches it on demand',
    sent.length > beforeOpen && opened?.type === 'records:entry'
      && opened?.id === 'chat_1_NPCs::0',
    String(opened?.type))

  drive('records:entry', {
    type: 'records:entry', id: 'chat_1_NPCs::0', ok: true,
    content: 'Bram keeps <b>The Ash</b> in Khelt.',
  })
  const full = doc.querySelector('.dnd-rec__full')
  check('showed the full text', (full?.textContent ?? '').includes('Khelt'))
  check('as text, not markup — lore is model output',
    !(full?.innerHTML ?? '').includes('<b>The Ash</b>'))
}

console.log('\n── an empty Records tab ──')
const emptyRecords = (agent: Record<string, unknown>): void => drive('records:state', {
  type: 'records:state', ok: true, prefix: 'chat_1', totalTokens: 0, player: null, agent,
  groups: [{ id: 'npc', label: 'People', count: 0, tokens: 0, active: 0, entries: [] }],
})
emptyRecords({ enabled: true, runEvery: 3, repliesUntilNext: 2 })
check('says when the Lorebook Agent files next',
  /every 3 replies.*in 2 replies/.test(doc.querySelector('.dnd-rec__empty')?.textContent ?? ''),
  doc.querySelector('.dnd-rec__empty')?.textContent ?? '')
emptyRecords({ enabled: false, runEvery: 3, repliesUntilNext: 2 })
check('and says when it is off',
  /is off/.test(doc.querySelector('.dnd-rec__empty')?.textContent ?? ''),
  doc.querySelector('.dnd-rec__empty')?.textContent ?? '')

console.log('\n── the game system wizard ──')
drive('wizard:examples', {
  type: 'wizard:examples',
  examples: [{ label: '🌾 Farming', text: 'A farming sim with seasons.' }],
})
const wiz = doc.querySelector('.dnd-wiz')
check('wizard opened', !!wiz)
check('offered an example', !!doc.querySelector('.dnd-wiz__chip'))

const wizDesc = doc.querySelector('.dnd-wiz__desc') as HTMLTextAreaElement | null
;(doc.querySelector('.dnd-wiz__chip') as HTMLElement | null)?.click()
check('the example fills the box',
  (wizDesc?.value ?? '').includes('farming sim'), (wizDesc?.value ?? '').slice(0, 30))

const wizGo = doc.querySelector('.dnd-wiz__go') as HTMLButtonElement | null
if (wizGo) {
  const beforeDraft = sent.length
  wizGo.click()
  const asked = sent[sent.length - 1] as { type?: string; description?: string }
  check('asks the backend to design it',
    sent.length > beforeDraft && asked?.type === 'wizard:draft',
    String(asked?.type))
}

drive('wizard:draft', {
  type: 'wizard:draft',
  ok: true,
  draft: {
    name: 'Farming', icon: '🌾', description: 'A farming sim with seasons.',
    includeGm: true, gmTag: 'farming', gmContent: 'You track crop growth.',
    includeTracker: true, trackerTag: 'CROPS', trackerLabel: 'Crops',
    trackerIcon: '🌾', trackerContent: 'Plots and their growth stage.',
    driverTime: true, driverGmAnnotation: false, driverStatedFact: false,
    effectOwner: 'tracker',
  },
})
check('moved to the review step',
  (doc.querySelector('.dnd-wiz__name')?.textContent ?? '').includes('Farming'),
  doc.querySelector('.dnd-wiz__name')?.textContent ?? '')
const bodies = [...doc.querySelectorAll('.dnd-wiz__body')] as HTMLTextAreaElement[]
check('showed both halves, editable',
  bodies.length === 2 && bodies[0].value.includes('crop growth')
    && bodies[1].value.includes('growth stage'),
  String(bodies.length))
check('nothing saved by drafting alone',
  !sent.some(m => m.type === 'wizard:save'))

if (bodies.length === 2) {
  bodies[0].value = 'You track crop growth and blight.'
  const beforeSave = sent.length
  ;(doc.querySelector('.dnd-wiz__go:last-of-type') as HTMLElement | null)
    ?? (bodies[1].parentElement?.querySelector('.dnd-wiz__go') as HTMLElement | null)
  const saveBtn = [...doc.querySelectorAll('.dnd-wiz__go')]
    .find(b => b.textContent === 'Save and switch on') as HTMLElement | undefined
  saveBtn?.click()
  const savedMsg = sent[sent.length - 1] as { type?: string; enable?: boolean; draft?: any }
  check('saving sends the edited draft',
    sent.length > beforeSave && savedMsg?.type === 'wizard:save'
      && savedMsg?.enable === true
      && String(savedMsg?.draft?.gmContent).includes('blight'),
    'the review box is the source of truth')
}

console.log('\n── the companion panel ──')
check('registered its own drawer tab',
  calls.includes('ui.registerDrawerTab:companion'),
  calls.filter(c => c.startsWith('ui.registerDrawerTab')).join(', '))
check('asked the backend for the conversation',
  sent.some(m => m.type === 'companion:read'))

drive('companion:state', {
  type: 'companion:state',
  history: [
    { role: 'user', content: 'What is going on?' },
    { role: 'assistant', content: 'Something <b>moved</b> in the dark.' },
  ],
  prefs: {
    tutorialMode: false, injectLore: false, injectMemo: true, injectMap: false,
    lookback: 5, lookbackAll: false,
  },
  busy: false,
})

const log = doc.querySelector('.dnd-comp__log')
check('painted both sides of the conversation',
  (log?.querySelectorAll('.dnd-comp__msg').length ?? 0) === 2,
  String(log?.querySelectorAll('.dnd-comp__msg').length))
// The transcript is model output. Rendering it as HTML would let a reply from
// a compromised or simply odd model inject markup into the panel.
check('renders model output as text, not markup',
  !(log?.innerHTML ?? '').includes('<b>moved</b>')
    && (log?.textContent ?? '').includes('<b>moved</b>'),
  'the tags must survive as characters')
check('reflected the switches',
  (doc.querySelector('.dnd-comp__opts input') as HTMLInputElement | null) !== null)

const compInput = doc.querySelector('.dnd-comp__input') as HTMLTextAreaElement | null
const compSend = doc.querySelector('.dnd-comp__send') as HTMLButtonElement | null
if (compInput && compSend) {
  compInput.value = 'Light a torch.'
  const beforeAsk = sent.length
  compSend.click()
  const asked = sent[sent.length - 1] as { type?: string; text?: string }
  check('sending asks the companion',
    sent.length > beforeAsk && asked?.type === 'companion:ask'
      && asked?.text === 'Light a torch.',
    String(asked?.type))
  check('and clears the box', compInput.value === '')
}

// A turn can run long, so the send button doubles as the way out of one.
drive('companion:state (busy)', {
  type: 'companion:state',
  history: [{ role: 'user', content: 'Light a torch.' }],
  prefs: {
    tutorialMode: false, injectLore: false, injectMemo: true, injectMap: false,
    lookback: 5, lookbackAll: false,
  },
  busy: true,
})
check('the send button becomes a stop button',
  compSend?.textContent === 'Stop', String(compSend?.textContent))
if (compSend) {
  const beforeStop = sent.length
  compSend.click()
  const stopped = sent[sent.length - 1] as { type?: string }
  check('and stops the turn',
    sent.length > beforeStop && stopped?.type === 'companion:cancel',
    String(stopped?.type))
}

console.log('\n── restoring an earlier memo ──')
// The picker loads an old version into the editor; committing is still the
// existing Save button, so there stays exactly one commit path.
drive('memo:content', {
  type: 'memo:content',
  text: '[CHARACTER]\nSyg\nHP: 2/8\n[/CHARACTER]',
  history: [
    { label: 'Previous version — Syg', text: '[CHARACTER]\nSyg\nHP: 8/8\n[/CHARACTER]' },
    { label: '2 versions back — Syg', text: '[CHARACTER]\nSyg\nHP: 5/8\n[/CHARACTER]' },
  ],
})

const historySelect = doc.querySelector('.dnd-panel__history') as HTMLSelectElement | null
const rawEditor = doc.querySelector('.dnd-panel__editor-text') as HTMLTextAreaElement | null
check('history picker appeared', historySelect?.hidden === false, String(historySelect?.hidden))
check('offers the current version plus each older one',
  historySelect?.options.length === 3, String(historySelect?.options.length))
check('the editor opened on the current memo',
  (rawEditor?.value ?? '').includes('2/8'))

if (historySelect && rawEditor) {
  const beforeRestore = sent.length
  historySelect.value = '0'
  historySelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  check('choosing a version loads it into the editor',
    rawEditor.value.includes('8/8'), rawEditor.value.slice(0, 30).replace(/\n/g, ' '))
  check('but does not commit it on its own',
    sent.length === beforeRestore,
    'the user still gets to look at it and press Save')

  const beforeSave = sent.length
  ;(doc.querySelector('.dnd-panel__editor-actions .dnd-panel__button') as HTMLElement | null)?.click()
  const saved = sent[sent.length - 1] as { type?: string; text?: string }
  check('Save commits the restored text',
    sent.length > beforeSave && saved?.type === 'memo:write'
      && String(saved?.text).includes('8/8'),
    String(saved?.type))
}

// With no history the control is noise and must stay away.
drive('memo:content (no history)', { type: 'memo:content', text: 'x', history: [] })
check('history picker hides when there is nothing to restore',
  historySelect?.hidden === true, String(historySelect?.hidden))

console.log('\n── portrait box ──')
// The rendered box has always carried "Drop image here or click to set
// portrait". Until now nothing was bound to it.
drive('panel:render (entity with a portrait box)', {
  type: 'panel:render',
  memoPresent: true,
  html: `<div class="rt-section-card" data-tag="PARTY">
    <div class="rt-section-body">
      <div class="rt-entity-container" data-entity-name="Bram (Innkeeper)">
        <div class="rt-entity-portrait-container" title="Drop image here or click to set portrait">
          <i class="rt-entity-portrait-placeholder"></i>
        </div>
        <div class="rt-entity-content">Bram</div>
      </div>
    </div>
  </div>`,
})

const box = doc.querySelector('.rt-entity-portrait-container') as HTMLElement | null
check('portrait box rendered', !!box)
if (box) {
  const beforeOpen = sent.length
  box.click()
  const opened = sent[sent.length - 1] as { type?: string; entity?: string }
  check('clicking it asks for the picker',
    sent.length > beforeOpen && opened?.type === 'portrait:open'
      && opened?.entity === 'Bram (Innkeeper)',
    `${opened?.type} ${opened?.entity}`)
}

drive('portrait:options', {
  type: 'portrait:options',
  entity: 'Bram (Innkeeper)',
  current: '',
  personas: [{ id: 'persona-1', name: 'Syg', url: '/api/v1/images/img-1' }],
})
const portraitUi = doc.querySelector('.dnd-portrait')
check('portrait picker opened', !!portraitUi)
check('offers a persona image',
  [...(portraitUi?.querySelectorAll('option') ?? [])].some(o => o.textContent === 'Syg'))
check('offers a file upload',
  !!portraitUi?.querySelector('input[type="file"]'))
check('no "remove" when there is no portrait yet',
  !portraitUi?.querySelector('.dnd-portrait__remove'))

const personaSelect = portraitUi?.querySelector('select') as HTMLSelectElement | null
if (personaSelect) {
  const beforeSet = sent.length
  personaSelect.value = 'persona-1'
  personaSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  const set = sent[sent.length - 1] as { type?: string; personaId?: string; entity?: string }
  check('choosing a persona sets the portrait',
    sent.length > beforeSet && set?.type === 'portrait:set'
      && set?.personaId === 'persona-1' && set?.entity === 'Bram (Innkeeper)',
    `${set?.type} ${set?.personaId}`)
}

console.log('\n── rolling and reviewing a character ──')
// The roll used to commit the instant the model answered. It now goes through
// a review, and these checks are about what does NOT happen before approval.
drive('roll:options', {
  type: 'roll:options',
  genre: 'fantasy',
  genres: ['fantasy', 'scifi'],
  archetypes: ['Fighter', 'Rogue'],
  personas: [{ id: 'persona-1', name: 'Syg', hasImage: true }],
})

const picker = doc.querySelector('.dnd-roll')
check('roll picker opened', !!picker)
check('picker offers a custom class',
  [...(picker?.querySelectorAll('option') ?? [])]
    .some(o => o.textContent === 'Custom…'))
check('picker offers personas',
  [...(picker?.querySelectorAll('option') ?? [])]
    .some(o => (o.textContent ?? '').includes('Syg')))

let beforeRoll = sent.length
;(picker?.querySelector('.dnd-roll__go') as HTMLElement | null)?.click()
const rollRequest = sent[sent.length - 1] as { type?: string; className?: string }
check('picker asked the backend to roll',
  sent.length > beforeRoll && rollRequest?.type === 'roll:go', String(rollRequest?.type))

const SHEET = '[CHARACTER]\nVex (Rogue)\nHP: 14/14\n[/CHARACTER]'
drive('roll:draft', {
  type: 'roll:draft',
  ok: true,
  name: 'Vex',
  memo: SHEET,
  portraitUrl: '/api/v1/images/img-1',
})

const review = [...doc.querySelectorAll('.dnd-rollrev')].pop() as HTMLElement | undefined
check('review opened', !!review)
const sheetBox = review?.querySelector('.dnd-rollrev__sheet') as HTMLTextAreaElement | null
check('review shows the rolled sheet', sheetBox?.value === SHEET,
  (sheetBox?.value ?? '').slice(0, 30).replace(/\n/g, ' '))
check('review names the character',
  review?.querySelector('.dnd-rollrev__name')?.textContent === 'Vex')

// Seeding from a persona exists to supply a portrait; showing it is how the
// user knows they will get one.
const portraitImg = review?.querySelector('.dnd-rollrev__portrait') as HTMLImageElement | null
check('review shows the persona portrait',
  portraitImg?.hidden === false && portraitImg?.getAttribute('src') === '/api/v1/images/img-1',
  String(portraitImg?.getAttribute('src')))

check('nothing committed by opening the review',
  !sent.some(m => m.type === 'roll:commit'),
  'the whole point of reviewing first')

// "Roll again" repeats the picker's choices without reopening the picker.
beforeRoll = sent.length
;(review?.querySelector('.dnd-rollrev__row .dnd-panel__button') as HTMLElement | null)?.click()
const reroll = sent[sent.length - 1] as { type?: string; className?: string }
check('Roll again repeats the same request',
  sent.length > beforeRoll && reroll?.type === 'roll:go'
    && reroll?.className === rollRequest?.className,
  String(reroll?.type))

// A failed reroll must not wipe the sheet the user is already looking at.
drive('roll:draft (failed reroll)', {
  type: 'roll:draft', ok: false, reason: 'the model did not return a character sheet',
})
check('reuses the open review rather than stacking a second',
  doc.querySelectorAll('.dnd-rollrev').length === 1,
  String(doc.querySelectorAll('.dnd-rollrev').length))
check('a failed reroll keeps the earlier sheet', sheetBox?.value === SHEET,
  (sheetBox?.value ?? '').slice(0, 30).replace(/\n/g, ' '))
check('a failed reroll says so',
  (review?.querySelector('.dnd-rollrev__note') as HTMLElement | null)?.hidden === false)

if (sheetBox) {
  sheetBox.value = `${SHEET}\nNotes: left-handed.`
  const beforeCommit = sent.length
  ;(review?.querySelector('.dnd-rollrev__keep') as HTMLElement | null)?.click()
  const commit = sent[sent.length - 1] as { type?: string; memo?: string }
  check('approving commits', sent.length > beforeCommit && commit?.type === 'roll:commit',
    String(commit?.type))
  check('commits what the user left in the box, not what the model wrote',
    String(commit?.memo ?? '').includes('left-handed'))
}

// With no review open, a failed roll has to surface somewhere the user looks.
const beforeFailed = sent.length
drive('roll:draft (failed, no review open)', {
  type: 'roll:draft', ok: false, reason: 'generation permission not granted',
})
check('a failed roll commits nothing',
  !sent.slice(beforeFailed).some(m => m.type === 'roll:commit'))
check('a failed roll is reported in the panel',
  (doc.querySelector('.dnd-panel__result')?.textContent ?? '').includes('Nothing rolled'),
  doc.querySelector('.dnd-panel__result')?.textContent ?? '')

console.log('\n── story so far ──')
const storyBox = (): HTMLElement | null => doc.querySelector('.dnd-panel__story')
check('hidden while the chat has no Loom summary', storyBox()?.hidden === true)
drive('story:state', { type: 'story:state', chatId: 'chat-1', summary: 'The hero escaped the Baron\u2019s keep.' })
check('shows Loom\u2019s summary once there is one',
  storyBox()?.hidden === false && /escaped the Baron/.test(storyBox()?.textContent ?? ''),
  storyBox()?.textContent ?? '')
check('collapsed, so it does not push the tracker down',
  storyBox()?.tagName === 'DETAILS' && !(storyBox() as HTMLDetailsElement | null)?.open)
drive('story:state', { type: 'story:state', chatId: 'chat-2', summary: '' })
check('and hides again for a chat without one', storyBox()?.hidden === true)

console.log('\n── which chat this tab shows ──')
check('every message says which chat the tab is showing',
  sent.length > 0 && sent.every(m => m.viewChatId === 'chat-on-screen'),
  sent.filter(m => m.viewChatId !== 'chat-on-screen').map(m => `${m.type}:${m.viewChatId}`).slice(0, 3).join(', '))
const beforeSwitch = sent.length
eventHandlers.get('CHAT_SWITCHED')?.({ chatId: null })
check('when the account switches chats, the tab in use says what it shows',
  sent.slice(beforeSwitch).some(m => m.type === 'chat:viewing' && m.viewChatId === 'chat-on-screen'),
  sent.slice(beforeSwitch).map(m => m.type).join(', '))
viewing = null
const beforeIdle = sent.length
eventHandlers.get('CHAT_SWITCHED')?.({ chatId: null })
check('a tab showing no chat says nothing', sent.length === beforeIdle)

console.log('\n── teardown ──')
try {
  teardown?.()
  check('teardown() did not throw', true)
} catch (error) {
  check('teardown() did not throw', false, (error as Error).message)
}
check('drawer tab destroyed', calls.includes('tab.destroy'))
check('and stops listening for chat switches', !eventHandlers.has('CHAT_SWITCHED'))

console.log(`\n${failures === 0 ? 'frontend test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
