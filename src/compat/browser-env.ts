/**
 * browser-env.ts — the browser globals the engine expects, for a backend that
 * has none.
 *
 * Upstream ran entirely in the browser, so engine modules reach for
 * `localStorage` and occasionally for `document` even in files that are
 * otherwise DOM-free. In the Spindle backend neither exists, and the failure is
 * abrupt: `getSettings()` throws `ReferenceError: localStorage is not defined`
 * on the first call, which takes the whole tracker down.
 *
 * Two different treatments, because the two globals mean different things here:
 *
 *   localStorage — real. It holds UI preferences and small persisted flags that
 *                  the engine genuinely relies on, so it is backed by
 *                  `spindle.storage` with a synchronous in-memory cache.
 *   document     — inert. Every remaining use is a UI refresh (getElementById,
 *                  dispatchEvent, a detached createElement) that has no meaning
 *                  without a page. These no-op rather than throw; the frontend
 *                  owns rendering now.
 */

import { userScope } from './user-context'

const STORAGE_PATH = 'local-storage.json'
const FLUSH_DEBOUNCE_MS = 500

let flushTimer: ReturnType<typeof setTimeout> | null = null

class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.map.get(String(key)) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value))
    scheduleFlush()
  }

  removeItem(key: string): void {
    this.map.delete(String(key))
    scheduleFlush()
  }

  clear(): void {
    this.map.clear()
    scheduleFlush()
  }

  /** Bulk-load without triggering a write back to where the data came from. */
  hydrate(entries: Record<string, string>): void {
    for (const [key, value] of Object.entries(entries ?? {})) {
      this.map.set(key, String(value))
    }
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.map)
  }

  // Storage's index signature; the engine only uses the methods.
  [name: string]: unknown
}

const storage = new MemoryStorage()

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void spindle.userStorage.setJson(STORAGE_PATH, storage.snapshot(), { userId: userScope() }).catch(error => {
      spindle.log.error(`[DnD] localStorage flush failed: ${(error as Error).message}`)
    })
  }, FLUSH_DEBOUNCE_MS)
}

/**
 * SillyTavern loads toastr globally and the engine calls it 44 times across
 * four files. Unshimmed those are ReferenceErrors on paths that only run when
 * something has already gone wrong — the worst place to add a second failure.
 * Mapped onto host toasts so the user sees the same message.
 */
const toastr = {
  success: (message: string) => spindle.toast.success(String(message)),
  info: (message: string) => spindle.toast.info(String(message)),
  warning: (message: string) => spindle.toast.warning(String(message)),
  error: (message: string) => spindle.toast.error(String(message)),
  clear: () => {},
  remove: () => {},
}

/**
 * A no-op jQuery.
 *
 * SillyTavern loads jQuery globally and the ported engine still calls it 84
 * times — every one of them writing a value into a settings-drawer input that
 * does not exist here (`$('#rpg_world_progression_skeleton_factions').val(...)`).
 * Unstubbed, the first such line throws `$ is not defined` and takes out the
 * function around it: the chat-state loader half-applied a snapshot and then
 * died, which is worse than either applying or not.
 *
 * Chainable and inert. If a real DOM surface is ever needed the frontend owns
 * it, not this.
 */
interface JQueryStub {
  (selector?: unknown): JQueryStub
  val(...args: unknown[]): JQueryStub | string
  prop(...args: unknown[]): JQueryStub | boolean
  text(...args: unknown[]): JQueryStub | string
  html(...args: unknown[]): JQueryStub | string
  css(...args: unknown[]): JQueryStub
  attr(...args: unknown[]): JQueryStub | string
  addClass(...args: unknown[]): JQueryStub
  removeClass(...args: unknown[]): JQueryStub
  toggleClass(...args: unknown[]): JQueryStub
  toggle(...args: unknown[]): JQueryStub
  show(...args: unknown[]): JQueryStub
  hide(...args: unknown[]): JQueryStub
  find(...args: unknown[]): JQueryStub
  on(...args: unknown[]): JQueryStub
  off(...args: unknown[]): JQueryStub
  trigger(...args: unknown[]): JQueryStub
  append(...args: unknown[]): JQueryStub
  remove(...args: unknown[]): JQueryStub
  empty(...args: unknown[]): JQueryStub
  each(...args: unknown[]): JQueryStub
}

function createJQueryStub(): JQueryStub {
  const chain = ((): JQueryStub => stub) as JQueryStub

  // Getters must return a value, not the chain: `$(x).val()` with no argument
  // is read as a string by the engine.
  const accessor = (empty: string | boolean) =>
    (...args: unknown[]): JQueryStub | string | boolean =>
      (args.length ? stub : empty)

  const stub = Object.assign(chain, {
    val: accessor(''),
    prop: accessor(false),
    text: accessor(''),
    html: accessor(''),
    attr: accessor(''),
    css: () => stub,
    addClass: () => stub,
    removeClass: () => stub,
    toggleClass: () => stub,
    toggle: () => stub,
    show: () => stub,
    hide: () => stub,
    find: () => stub,
    on: () => stub,
    off: () => stub,
    trigger: () => stub,
    append: () => stub,
    remove: () => stub,
    empty: () => stub,
    each: () => stub,
    // No `length`: it is a readonly property on a function, and Object.assign
    // throws rather than skipping it.
  }) as JQueryStub

  return stub
}

/** A detached element stub. Enough shape that property writes do not throw. */
function createStubElement(tag: string): Record<string, unknown> {
  const element: Record<string, unknown> = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    children: [],
    innerHTML: '',
    textContent: '',
    appendChild: (child: unknown) => child,
    removeChild: (child: unknown) => child,
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  }
  return element
}

/**
 * How to actually send a message the engine "typed" into the chat box.
 *
 * The Adventure Companion's `act_for_user` takes a turn on the player's behalf
 * the only way it can in a browser extension: it writes into SillyTavern's
 * `#send_textarea` and clicks `#send_but`. There is no such DOM here, and the
 * action is the whole point of the feature — it is what lets the companion play
 * a CYOA choice for you.
 *
 * So those two ids get working stand-ins rather than the inert stub. Everything
 * else still resolves to null: this is a deliberate, named exception, not a
 * general DOM.
 */
let sendChatMessage: ((text: string) => Promise<void>) | null = null

export function setChatInputSink(sink: (text: string) => Promise<void>): void {
  sendChatMessage = sink
}

/** Whatever the engine last typed into the stand-in textarea. */
let pendingChatText = ''

const chatTextarea = {
  ...createStubElement('textarea'),
  id: 'send_textarea',
  get value(): string { return pendingChatText },
  set value(next: string) { pendingChatText = String(next ?? '') },
}

const chatSendButton = {
  ...createStubElement('button'),
  id: 'send_but',
  // The engine checks `disabled` and reports "busy" rather than dropping the
  // turn, so an unwired sink must read as busy, not as a silent success.
  get disabled(): boolean { return sendChatMessage === null },
  click(): void {
    const text = pendingChatText.trim()
    pendingChatText = ''
    if (!text || !sendChatMessage) return
    void sendChatMessage(text).catch((error: Error) => {
      spindle.log.error(`[DnD] companion could not take the turn: ${error.message}`)
    })
  },
}

const inertDocument = {
  body: null,
  documentElement: null,
  getElementById: (id: string) => {
    if (id === 'send_textarea') return chatTextarea
    if (id === 'send_but') return chatSendButton
    return null
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag: string) => createStubElement(tag),
  createDocumentFragment: () => createStubElement('fragment'),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
}

/**
 * Install the shims. Synchronous, and must run before any engine module is
 * imported — several read `localStorage` during module initialisation, long
 * before the host has told us which user we are acting for.
 *
 * The store starts empty; `hydrateBrowserEnv()` fills it in once a user is
 * known. Reading a not-yet-hydrated preference returns null, which every
 * consumer already handles as "no preference saved".
 */
export function installBrowserEnv(): void {
  const target = globalThis as Record<string, unknown>

  if (typeof target.localStorage === 'undefined') target.localStorage = storage
  if (typeof target.sessionStorage === 'undefined') target.sessionStorage = new MemoryStorage()
  if (typeof target.document === 'undefined') target.document = inertDocument
  if (typeof target.window === 'undefined') {
    target.window = Object.assign(target, { innerWidth: 1920, innerHeight: 1080 })
  }
  if (typeof target.navigator === 'undefined') {
    target.navigator = { userAgent: 'Lumiverse/Spindle' }
  }
  if (typeof target.toastr === 'undefined') target.toastr = toastr
  if (typeof target.$ === 'undefined') {
    const jquery = createJQueryStub()
    target.$ = jquery
    target.jQuery = jquery
  }
}

/** Load this user's stored preferences. Safe to call more than once. */
export async function hydrateBrowserEnv(): Promise<void> {
  try {
    const stored = await spindle.userStorage.getJson<Record<string, string>>(STORAGE_PATH, {
      fallback: {},
      userId: userScope(),
    })
    storage.hydrate(stored ?? {})
  } catch (error) {
    spindle.log.warn(`[DnD] localStorage hydrate failed, starting empty: ${(error as Error).message}`)
  }
}

/** Force any pending localStorage write to disk. Used on teardown. */
export async function flushBrowserEnv(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await spindle.userStorage.setJson(STORAGE_PATH, storage.snapshot(), { userId: userScope() })
}
