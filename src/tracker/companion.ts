/**
 * companion.ts — the Adventure Companion.
 *
 * A side conversation with someone who can see your campaign: the state memo,
 * the lorebook, the active map, the last few story messages. Unlike the tracker
 * it can also *act* — run a tracker pass, run the Lorebook Agent, run the map
 * updater, or take a turn for you.
 *
 * Upstream's `adventure-companion.js` is one file holding both the reasoning
 * and a floating SillyTavern panel. The reasoning comes across whole; the panel
 * is rebuilt in `src/ui/companion.ts`, like every other surface in this port.
 *
 * The pieces upstream keeps module-private — prompt assembly, the context
 * builders — are re-exported by `scripts/port.mjs` rather than reimplemented
 * here. Rewriting prompt assembly is exactly how a fork drifts from the engine
 * it claims to track.
 *
 * ## Actions
 *
 * `act_for_user` types into SillyTavern's chat box and clicks send. There is no
 * such DOM here, so `compat/browser-env.ts` gives those two element ids working
 * stand-ins wired to `setChatInputSink()`. Without a sink they report "busy",
 * which the engine surfaces honestly, rather than claiming a turn was taken.
 */

import { chatMirror } from '../compat/chat-mirror'
import { inheritConnections } from './connections'

export interface CompanionMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CompanionPrefs {
  tutorialMode: boolean
  injectLore: boolean
  injectMemo: boolean
  injectMap: boolean
  lookback: number
  lookbackAll: boolean
}

interface EngineBits {
  getSettings: () => Record<string, any>
  getRequestSettings: (settings?: unknown) => Record<string, unknown>
  getPreferences: () => CompanionPrefs
  updatePreferences: (patch: Partial<CompanionPrefs>) => void
  activeModePrefs: () => { history: CompanionMessage[]; lookback: number; lookbackAll: boolean }
  savePrefs: (prefs: unknown) => void
  /** The engine's live prefs object, which `savePrefs` expects to be handed. */
  prefs: () => unknown
  runAgentLoop: (messages: unknown[], signal: AbortSignal | null) => Promise<string>
  buildSystemPrompt: (parts: Record<string, string>) => string
  buildNarrativeContext: (all: boolean, n: number) => string
  buildMemoContext: () => string
  buildLoreContext: () => Promise<string>
  buildMapContext: () => Promise<string>
  buildActForUserContext: () => string
  loadDocumentation: () => Promise<string>
  getSnapshot: () => unknown
  applySnapshot: (snap: unknown, opts?: Record<string, unknown>) => void
  loadForChat: (chatId: string | null) => void
  flushForChat: (chatId: string | null) => void
  onChatChanged: (oldChatId: string | null, newChatId: string | null) => void
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, companion] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/adventure-companion.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    getRequestSettings: companion.getAdventureCompanionRequestSettings,
    getPreferences: companion.getAdventureCompanionPreferences,
    updatePreferences: companion.updateAdventureCompanionPreferences,
    activeModePrefs: companion.activeModePrefs,
    savePrefs: companion.savePrefs,
    // `savePrefs` takes the whole prefs object rather than reading a module
    // global, and the engine reassigns `_prefs` on load — so read it live.
    prefs: () => companion._prefs,
    runAgentLoop: companion.runCompanionAgentLoop,
    buildSystemPrompt: companion.buildSystemPrompt,
    buildNarrativeContext: companion.buildNarrativeContext,
    buildMemoContext: companion.buildMemoContext,
    buildLoreContext: companion.buildLoreContext,
    buildMapContext: companion.buildMapContext,
    buildActForUserContext: companion.buildActForUserContext,
    loadDocumentation: companion.loadDocumentation,
    getSnapshot: companion.getAdventureCompanionSnapshot,
    applySnapshot: companion.applyAdventureCompanionSnapshot,
    loadForChat: companion.loadAdventureCompanionForChat,
    flushForChat: companion.flushAdventureCompanionForChat,
    onChatChanged: companion.onChatChangedForAdventureCompanion,
  }
  return cached
}

/** In-flight turn, so the panel can cancel a long one. */
let inFlight: AbortController | null = null

export function isCompanionBusy(): boolean {
  return inFlight !== null
}

export function cancelCompanionTurn(): void {
  inFlight?.abort()
}

/** The conversation so far, for painting the panel. */
export async function readCompanionHistory(): Promise<CompanionMessage[]> {
  const bits = await engine()
  try {
    return [...bits.activeModePrefs().history]
  } catch (error) {
    spindle.log.warn(`[DnD] companion history unavailable: ${(error as Error).message}`)
    return []
  }
}

export async function readCompanionPrefs(): Promise<CompanionPrefs> {
  const bits = await engine()
  return bits.getPreferences()
}

export async function writeCompanionPrefs(patch: Partial<CompanionPrefs>): Promise<CompanionPrefs> {
  const bits = await engine()
  bits.updatePreferences(patch)
  return bits.getPreferences()
}

/** Drop the conversation for this chat. */
export async function clearCompanionHistory(): Promise<void> {
  const bits = await engine()
  bits.activeModePrefs().history = []
  bits.savePrefs(bits.prefs())
  const chatId = chatMirror.getChatId()
  if (chatId) bits.flushForChat(chatId)
}

export interface CompanionReply {
  ok: boolean
  reply?: string
  reason?: string
}

/**
 * Take one turn.
 *
 * Mirrors upstream's `sendMessage()`: assemble the context the user asked for,
 * run the agent loop, and record both sides of the exchange — including a
 * failure, so the transcript shows what happened rather than swallowing it.
 */
export async function askCompanion(text: string, userId?: string): Promise<CompanionReply> {
  const message = String(text ?? '').trim()
  if (!message) return { ok: false, reason: 'nothing to ask' }
  if (!spindle.permissions.has('generation')) {
    return { ok: false, reason: 'generation permission not granted' }
  }
  if (inFlight) return { ok: false, reason: 'the companion is still answering' }

  const bits = await engine()
  const settings = bits.getSettings()
  // The companion has its own connection, defaulting to a "main API" that does
  // not exist here. See connections.ts.
  inheritConnections(settings)

  const prefs = bits.getPreferences()
  const mode = bits.activeModePrefs()
  mode.history.push({ role: 'user', content: message })
  bits.savePrefs(bits.prefs())

  inFlight = new AbortController()
  try {
    const narrative = (mode.lookbackAll || mode.lookback > 0)
      ? bits.buildNarrativeContext(mode.lookbackAll, mode.lookback)
      : ''

    const systemPrompt = bits.buildSystemPrompt({
      doc: prefs.tutorialMode ? await bits.loadDocumentation() : '',
      narrative,
      memo: prefs.injectMemo ? bits.buildMemoContext() : '',
      lore: prefs.injectLore ? await bits.buildLoreContext() : '',
      map: prefs.injectMap ? await bits.buildMapContext() : '',
      playerAction: bits.buildActForUserContext(),
    })

    const reply = await bits.runAgentLoop([
      { role: 'system', content: systemPrompt },
      ...mode.history.map(entry => ({ role: entry.role, content: entry.content })),
    ], inFlight.signal)

    mode.history.push({ role: 'assistant', content: reply })
    return { ok: true, reply }
  } catch (error) {
    const err = error as Error
    const cancelled = err.name === 'AbortError'
    // Upstream keeps the failure in the transcript rather than dropping the
    // turn, so the conversation still reads as a conversation.
    const note = cancelled
      ? '(Cancelled.)'
      : `I could not reach the model. Check the Adventure Companion connection.\n\n${err.message}`
    mode.history.push({ role: 'assistant', content: note })
    if (!cancelled) spindle.log.error(`[DnD] companion turn failed: ${err.message}`)
    return { ok: false, reason: cancelled ? 'cancelled' : err.message }
  } finally {
    inFlight = null
    bits.savePrefs(bits.prefs())
    const chatId = chatMirror.getChatId()
    if (chatId) bits.flushForChat(chatId)
    void userId
  }
}

/**
 * Install the globals the chat-state loader calls to make the companion follow
 * the active chat, and give `act_for_user` somewhere to send a turn.
 *
 * Without the first three, switching chats leaves the previous campaign's
 * conversation on screen and writes it into the new chat's partition — the same
 * bug the tracker itself had before `chat-state.ts`.
 */
export async function installCompanionHooks(
  sendChat: (text: string) => Promise<void>,
): Promise<void> {
  const bits = await engine()
  const target = globalThis as Record<string, unknown>

  target._rpgGetAdventureCompanionSnapshot = () => bits.getSnapshot()
  target._rpgApplyAdventureCompanionSnapshot = (snap: unknown) => bits.applySnapshot(snap)
  target._rpgLoadAdventureCompanionForChat = (chatId: string) => bits.loadForChat(chatId ?? null)

  const { setChatInputSink } = await import('../compat/browser-env')
  setChatInputSink(sendChat)
}

/** Move the companion's conversation with the chat. */
export async function companionChatChanged(
  oldChatId: string | null,
  newChatId: string | null,
): Promise<void> {
  const bits = await engine()
  try {
    bits.onChatChanged(oldChatId, newChatId)
  } catch (error) {
    spindle.log.warn(`[DnD] companion chat switch failed: ${(error as Error).message}`)
  }
}
