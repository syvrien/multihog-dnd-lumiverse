/**
 * direct-prompt.ts — correcting tracker state by hand or by asking the model.
 *
 * The panel has been read-only until now, which is the port's most-felt gap in
 * practice: when the state model gets something wrong — the wrong HP, an item
 * it invented, a name it misspelled — there was no way to fix it. Upstream
 * offers two routes and this carries both across:
 *
 *   raw   — edit the memo text directly and commit it
 *   ask   — send an instruction ("Kestrel has 12 HP, not 8") to the state
 *           model, which returns changed sections that merge as a normal pass
 *
 * "Ask" reuses the tracker's own prompt assembly rather than inventing one, so
 * a correction behaves exactly like an automatic pass: same modules, same merge
 * semantics, same commit path.
 */

import { chatMirror } from '../compat/chat-mirror'

export interface EditResult {
  ok: boolean
  changed: boolean
  reason?: string
  /** The merged memo. Only set by a `preview` call, which does not commit. */
  memo?: string
}

interface EngineBits {
  getSettings: () => Record<string, any>
  saveChatState: (chatId: string, opts?: Record<string, unknown>) => unknown
  buildModulesInstructionText: (settings: unknown) => string
  buildDirectPromptSystemPrompt: (
    settings: unknown,
    modulesText: string,
    mode?: string,
  ) => string
  DIRECT_PROMPT_SYSTEM_MODES: Record<string, string>
  memoForTrackerContext: (memo: string) => string
  stripMemoHtml: (memo: string) => string
  cleanToolCallMessage: (text: string) => string | null
  mergeMemo: (current: string, output: string) => string
  computeDelta: (before: string, after: string) => string
  applyQuestSyncAndStripMemo: (memo: string) => string
  sendStateRequest: (
    settings: unknown,
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal | null,
    options?: Record<string, unknown>,
  ) => Promise<string>
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, memo, renderer, llm, persistence, direct] = await Promise.all([
    import('../engine/state-manager.js'),
    import('../engine/memo-processor.js'),
    import('../engine/renderer.js'),
    import('../engine/llm-client.js'),
    import('../engine/src/state/chat-persistence.js'),
    import('../engine/src/state/direct-prompt-system.js'),
  ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    saveChatState: persistence.saveChatState,
    buildModulesInstructionText: memo.buildModulesInstructionText,
    buildDirectPromptSystemPrompt: direct.buildDirectPromptSystemPrompt,
    DIRECT_PROMPT_SYSTEM_MODES: direct.DIRECT_PROMPT_SYSTEM_MODES,
    memoForTrackerContext: memo.memoForTrackerContext,
    stripMemoHtml: renderer.stripMemoHtml,
    cleanToolCallMessage: memo.cleanToolCallMessage,
    mergeMemo: memo.mergeMemo,
    computeDelta: memo.computeDelta,
    applyQuestSyncAndStripMemo: memo.applyQuestSyncAndStripMemo,
    sendStateRequest: llm.sendStateRequest,
  }
  return cached
}

/** Commit a memo, keeping history and delta consistent with a normal pass. */
function commit(
  settings: Record<string, any>,
  bits: EngineBits,
  priorMemo: string,
  nextMemo: string,
): boolean {
  if (nextMemo === priorMemo) return false

  settings.currentMemo = nextMemo
  settings.lastDelta = bits.computeDelta(priorMemo, nextMemo)
  settings.memoHistory = [priorMemo, ...(settings.memoHistory ?? [])]
    .slice(0, Math.max(1, settings.trackerHistoryCount ?? 3))

  const chatId = chatMirror.getChatId()
  if (!chatId) {
    spindle.log.warn('[DnD] no chat id at commit; edit kept in memory only')
    return true
  }
  try {
    bits.saveChatState(chatId)
    // A second copy, for the case where the settings tree itself comes back
    // short. The engine refuses to shrink it, so this is safe on every commit.
    void import('./recovery').then(({ snapshotMemo }) => snapshotMemo(chatId))
  } catch (error) {
    spindle.log.error(`[DnD] saving the edit failed: ${(error as Error).message}`)
  }
  return true
}

/** The memo as the user should see it for editing — no rendering markup. */
export async function readMemo(): Promise<string> {
  const bits = await engine()
  return String(bits.getSettings().currentMemo ?? '')
}

/**
 * A one-line label for an earlier memo, so the restore picker is readable.
 *
 * Entries are whole memos; the first line that is not a bracket tag is the
 * closest thing to a name they carry.
 */
function labelFor(memo: string, index: number): string {
  const line = memo
    .split('\n')
    .map(text => text.trim())
    .find(text => text && !/^\[\/?[A-Z0-9 _-]+\]$/i.test(text))
  const summary = (line ?? '(empty)').slice(0, 48)
  const age = index === 0 ? 'Previous version' : `${index + 1} versions back`
  return `${age} — ${summary}`
}

/**
 * Earlier memos, newest first.
 *
 * The engine has always kept these (`trackerHistoryCount`, default 3) and
 * nothing ever read them, so a state pass that mangled the sheet could not be
 * undone from the UI.
 */
export async function readMemoHistory(): Promise<Array<{ label: string; text: string }>> {
  const bits = await engine()
  const current = String(bits.getSettings().currentMemo ?? '')
  const entries = bits.getSettings().memoHistory
  if (!Array.isArray(entries)) return []
  return entries
    .map(entry => String(entry ?? ''))
    // An entry identical to what is on screen is not a version to go back to.
    .filter(text => text.trim() && text !== current)
    .map((text, index) => ({ label: labelFor(text, index), text }))
}

/** Replace the memo wholesale with hand-edited text. */
export async function writeMemo(text: string): Promise<EditResult> {
  const bits = await engine()
  const settings = bits.getSettings()
  const prior = String(settings.currentMemo ?? '')

  let next = String(text ?? '').trim()
  try {
    // Same post-processing a model pass gets, so a hand edit cannot leave the
    // quest log and the memo disagreeing.
    next = bits.applyQuestSyncAndStripMemo(next) ?? next
  } catch (error) {
    spindle.log.warn(`[DnD] quest sync failed on manual edit: ${(error as Error).message}`)
  }

  const changed = commit(settings, bits, prior, next)
  return { ok: true, changed }
}

export interface DirectPromptOptions {
  /** `state_extractor` (default) or `modules_only` for character creation. */
  systemPromptMode?: string
  /** Overrides the tracker's connection, e.g. the character-creation profile. */
  connectionSettings?: Record<string, unknown>
  /** Skip the prior-memo and narrative preamble; the caller supplies the lot. */
  rawPrompt?: boolean
  debugSource?: string
  /**
   * Merge but do not commit: return the would-be memo instead of writing it.
   *
   * Rolling a character replaces the whole sheet, so the user reviews what the
   * model produced before it lands. Without this the only way to see the new
   * character was to let it overwrite the old one first.
   */
  preview?: boolean
}

/**
 * Send an instruction to the state model and merge the reply.
 *
 * This backs both the panel's "Ask" box and the engine's `sendDirectPrompt`
 * runtime action. Character creation calls it with
 * `systemPromptMode: 'modules_only'` — the State Extractor's narrative-diff and
 * prior-memo rules would otherwise fight a prompt trying to author a sheet from
 * scratch — and with its own connection settings, so both have to be honoured
 * rather than ignored.
 */
export async function sendDirectPrompt(
  instruction: string,
  options: DirectPromptOptions = {},
): Promise<EditResult> {
  const message = String(instruction ?? '').trim()
  if (!message) return { ok: false, changed: false, reason: 'nothing to ask' }
  if (!spindle.permissions.has('generation')) {
    return { ok: false, changed: false, reason: 'generation permission not granted' }
  }

  const bits = await engine()
  const settings = bits.getSettings()
  const prior = String(settings.currentMemo ?? '')

  const modulesText = bits.buildModulesInstructionText(settings)
  const systemPrompt = bits.buildDirectPromptSystemPrompt(
    settings,
    modulesText,
    options.systemPromptMode ?? bits.DIRECT_PROMPT_SYSTEM_MODES?.STATE_EXTRACTOR,
  )

  let userPrompt = message
  if (!options.rawPrompt) {
    // A few recent messages give the model enough context to resolve names and
    // pronouns in the instruction.
    const lookback = Math.max(1, Number(settings.directPromptContext ?? 5))
    const lines: string[] = []
    for (const entry of chatMirror.messages.slice(-lookback)) {
      const content = bits.cleanToolCallMessage(entry.mes ?? '')
      if (content === null) continue
      lines.push(`${entry.is_user ? 'Player' : (entry.name || 'Narrator')}: ${content}`)
    }

    userPrompt =
      (lines.length ? `## NARRATIVE HISTORY (Last ${lines.length} messages)\n${lines.join('\n\n')}\n\n` : '')
      + `## PRIOR MEMO\n${bits.stripMemoHtml(bits.memoForTrackerContext(prior)) || '(empty)'}\n\n`
      + `## USER INSTRUCTION\n${message}\n\n`
      + '## OUTPUT ONLY CHANGED OR NEW SECTIONS:'
  }

  let raw = ''
  try {
    raw = await bits.sendStateRequest(
      (options.connectionSettings as Record<string, unknown>) ?? settings,
      systemPrompt,
      userPrompt,
      null,
      { debugSource: options.debugSource ?? 'DirectPrompt' },
    )
  } catch (error) {
    return { ok: false, changed: false, reason: (error as Error).message }
  }
  if (!raw || typeof raw !== 'string') {
    return { ok: false, changed: false, reason: 'the state model returned nothing' }
  }

  let output = raw
  const blocks = [...output.matchAll(/<memo>([\s\S]*?)<\/memo>/gi)]
  output = blocks.length
    ? blocks[blocks.length - 1][1].trim()
    : output.replace(/<\/?memo>/gi, '').trim()

  let merged = bits.mergeMemo(prior, output)
  try {
    merged = bits.applyQuestSyncAndStripMemo(merged) ?? merged
  } catch (error) {
    spindle.log.warn(`[DnD] quest sync failed: ${(error as Error).message}`)
  }

  if (options.preview) {
    return { ok: true, changed: merged !== prior, memo: merged }
  }

  const changed = commit(settings, bits, prior, merged)
  return {
    ok: true,
    changed,
    reason: changed ? undefined : 'the model replied but nothing changed',
  }
}

/** The panel's "Ask" box — a direct prompt with the default system mode. */
export function askTracker(instruction: string): Promise<EditResult> {
  return sendDirectPrompt(instruction)
}
