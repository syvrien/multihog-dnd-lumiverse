/**
 * state-pass.ts — the State Tracker's second-pass model call.
 *
 * This is the one part of the tracker that is rebuilt rather than ported.
 * Upstream it lives inside `index.js` as `runStateModelPass()`, tangled with
 * jQuery status indicators, a detached-panel repaint, and the swipe scheduler.
 * `index.js` is the file the port replaces, so the logic is reimplemented here
 * against the engine's own exported pieces — the prompt assembly, chunking and
 * merge semantics follow upstream deliberately.
 *
 * What it does, once per narrator turn:
 *
 *   1. collect the messages since the last user turn
 *   2. build the tracker system prompt from the enabled modules
 *   3. ask the state model for the changed sections
 *   4. merge that into the running memo and commit
 *
 * It must never run inside the interceptor. Lumiverse gives interceptors a
 * wall-clock budget (10s default, 60s requested in the manifest); a second
 * model call does not belong inside it. This runs on `GENERATION_ENDED`.
 */

import { chatMirror, type StMessage } from '../compat/chat-mirror'

/** Upstream's default when `lookbackMessages` is unset. */
const DEFAULT_LOOKBACK = 2

let running = false
let controller: AbortController | null = null

export function isStatePassRunning(): boolean {
  return running
}

/** Abort an in-flight pass. Used on chat switch and teardown. */
export function stopStatePass(): void {
  controller?.abort()
  controller = null
  running = false
}

interface EngineBits {
  getSettings: () => Record<string, any>
  /** Takes the chat id; returns silently when it is missing. */
  saveChatState: (chatId: string, opts?: Record<string, unknown>) => unknown
  buildModulesInstructionText: (settings: unknown) => string
  buildLorebookContext: () => Promise<string>
  memoForTrackerContext: (memo: string) => string
  cleanToolCallMessage: (text: string) => string | null
  mergeMemo: (current: string, output: string) => string
  computeDelta: (before: string, after: string) => string
  /** Syncs quests out of the memo and strips archived ones. */
  applyQuestSyncAndStripMemo: (memo: string) => string
  /** Which relationship pipeline the user has selected. */
  getRelationshipUpdateMode: (settings: unknown) => string
  /** Pulls [RELATIONS] blocks out of the model reply. */
  extractStateTrackerRelationshipCommands: (response: string) => {
    memo: string
    commands: unknown[]
  }
  /** Applies extracted commands to NPC relationship values. */
  applyStateTrackerRelationshipCommands: (
    commands: unknown[],
    options?: Record<string, unknown>,
  ) => Promise<{ applied: boolean; status: string }>
  /** The instruction that teaches the state model the command syntax. */
  buildStateTrackerRelationshipCommandInstruction: (
    max: number,
    isFullContext?: boolean,
    customPrompt?: string,
  ) => string
  getNpcRelationshipMax: (settings: unknown) => number
  RELATIONSHIP_STATE_TRACKER_MODE: string
  /** The stricter core prompt used by Full review mode and by a full audit. */
  FULL_REVIEW_STATE_SYSTEM_PROMPT: string
  FULL_REVIEW_USER_PROMPT_SUFFIX: string
  stripMemoHtml: (memo: string) => string
  sendStateRequest: (
    settings: unknown,
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal | null,
    options?: Record<string, unknown>,
  ) => Promise<string>
  checkQuestDeadlines?: () => void
}

let cached: EngineBits | null = null

async function engine(): Promise<EngineBits> {
  if (cached) return cached
  const [stateManager, memo, renderer, llm, quests, persistence, hooks, relationships] =
    await Promise.all([
      import('../engine/state-manager.js'),
      import('../engine/memo-processor.js'),
      import('../engine/renderer.js'),
      import('../engine/llm-client.js'),
      import('../engine/quests.js'),
      import('../engine/src/state/chat-persistence.js'),
      import('../engine/narrative-hooks.js'),
      import('../engine/src/state/relationship-prompts.js'),
    ]) as any[]

  cached = {
    getSettings: stateManager.getSettings,
    saveChatState: persistence.saveChatState,
    buildModulesInstructionText: memo.buildModulesInstructionText,
    buildLorebookContext: memo.buildLorebookContext,
    memoForTrackerContext: memo.memoForTrackerContext,
    cleanToolCallMessage: memo.cleanToolCallMessage,
    mergeMemo: memo.mergeMemo,
    computeDelta: memo.computeDelta,
    applyQuestSyncAndStripMemo: memo.applyQuestSyncAndStripMemo,
    getRelationshipUpdateMode: relationships.getRelationshipUpdateMode,
    extractStateTrackerRelationshipCommands: stateManager.extractStateTrackerRelationshipCommands,
    applyStateTrackerRelationshipCommands: hooks.applyStateTrackerRelationshipCommands,
    buildStateTrackerRelationshipCommandInstruction:
      relationships.buildStateTrackerRelationshipCommandInstruction,
    getNpcRelationshipMax: stateManager.getNpcRelationshipMax,
    RELATIONSHIP_STATE_TRACKER_MODE:
      relationships.RELATIONSHIP_UPDATE_MODES?.STATE_TRACKER ?? 'state_tracker',
    FULL_REVIEW_STATE_SYSTEM_PROMPT: stateManager.FULL_REVIEW_STATE_SYSTEM_PROMPT,
    FULL_REVIEW_USER_PROMPT_SUFFIX: stateManager.FULL_REVIEW_USER_PROMPT_SUFFIX,
    stripMemoHtml: renderer.stripMemoHtml,
    sendStateRequest: llm.sendStateRequest,
    checkQuestDeadlines: quests.checkQuestDeadlines,
  }
  return cached
}

/**
 * Format the messages the state model should read.
 *
 * Upstream default is "everything since the most recent user message", which
 * captures a whole turn even when tool calls split it across several messages.
 * A fixed lookback wins when the user has configured one.
 */
function collectNarrative(
  chat: StMessage[],
  settings: Record<string, any>,
  clean: EngineBits['cleanToolCallMessage'],
): string[] {
  if (!chat.length) return []

  let startIdx: number
  if (settings.lookbackSinceLastUser === false) {
    const n = settings.lookbackMessages ?? DEFAULT_LOOKBACK
    startIdx = Math.max(0, chat.length - n)
  } else {
    startIdx = chat.length - 1
    while (startIdx > 0 && !chat[startIdx].is_user) startIdx--
    // An all-narrator chat has no user message to anchor on.
    if (startIdx === 0 && !chat[0]?.is_user) {
      startIdx = Math.max(0, chat.length - DEFAULT_LOOKBACK)
    }
  }

  const lines: string[] = []
  for (const message of chat.slice(startIdx)) {
    const content = clean(message.mes ?? '')
    // `cleanToolCallMessage` returns null for tool-call messages; those are
    // excluded from state model context upstream.
    if (content === null) continue
    lines.push(`${message.is_user ? 'Player' : (message.name || 'Narrator')}: ${content}`)
  }
  return lines
}

function relationshipModeActive(settings: Record<string, any>, bits: EngineBits): boolean {
  return !!settings.npcRelationshipBars
    && bits.getRelationshipUpdateMode(settings) === bits.RELATIONSHIP_STATE_TRACKER_MODE
}

/**
 * Rewrite the shipped date examples when the user has picked DD/MM/YYYY.
 *
 * The core prompt teaches the memo's time format by example (`[Day 3, 14:00]`),
 * so leaving these alone while the renderer shows real dates trains the model
 * to write the format the rest of the extension does not use.
 */
function applyDateFormat(prompt: string): string {
  return prompt
    .replace(/\[Day\s+X,\s+HH:MM\]/g, '[DD/MM/YYYY, HH:MM]')
    .replace(/Day\s+3,\s+14:00/g, '03/01/2026, 14:00')
    .replace(/Day\s+1,\s+11:52/g, '01/01/2026, 11:52')
    .replace(/Day\s+1/g, '01/01/2026')
    .replace(/Day\s+2/g, '02/01/2026')
    .replace(/Day\s+3/g, '03/01/2026')
    .replace(/Day\s+4/g, '04/01/2026')
    .replace(/Day\s+6/g, '06/01/2026')
    .replace(/Day\s+N/g, 'DD/MM/YYYY')
    .replace(/Day\s+X/g, 'DD/MM/YYYY');
}

function buildSystemPrompt(
  settings: Record<string, any>,
  bits: EngineBits,
  fullAudit = false,
): string {
  const modulesText = bits.buildModulesInstructionText(settings)
  // Full review mode swaps the core prompt for a stricter one that asks for the
  // whole memo every pass. The toggle has been in settings since the port
  // began; until now nothing read it and it changed nothing.
  const template = settings.fullReviewStateMode
    ? String(bits.FULL_REVIEW_STATE_SYSTEM_PROMPT ?? '')
    : String(settings.systemPromptTemplate ?? '')
  let prompt = template.replace('{{modulesText}}', modulesText)

  // In State Tracker mode the model emits [RELATIONS] commands alongside the
  // memo. Without this instruction it never learns the syntax, so the feature
  // looks enabled and silently produces nothing.
  if (relationshipModeActive(settings, bits)) {
    try {
      prompt += `

${bits.buildStateTrackerRelationshipCommandInstruction(
        bits.getNpcRelationshipMax(settings),
        fullAudit,
        settings.npcRelationshipStateTrackerPrompt ?? '',
      )}`
    } catch (error) {
      spindle.log.warn(`[DnD] relationship instruction failed: ${(error as Error).message}`)
    }
  }

  if (settings.useDdMmYyFormat) prompt = applyDateFormat(prompt)

  // An audit is the opposite instruction to an incremental pass: the core
  // prompt spends its length telling the model to output only what changed.
  if (fullAudit) {
    prompt = prompt
      .replace(
        /Only output sections that actually changed/gi,
        'Perform a full audit of the narrative history and output the COMPLETE state for all enabled modules',
      )
      .replace(
        /Omit unchanged sections entirely/gi,
        'Do NOT omit any section; output a complete, verified state memo',
      )
  }
  return prompt
}

/**
 * The prior-state half of the user prompt.
 *
 * `trackerHistoryCount` is how many past memos the model is shown, not merely
 * how many are archived — upstream stacks them as `TRACKER STATE -2`, `-1`, `0`
 * so the model can see what recently changed. The port kept the archive and
 * dropped the prompt half, which quietly made the setting cosmetic.
 */
function buildPriorMemoText(settings: Record<string, any>, bits: EngineBits): string {
  const asContext = (memo: string): string =>
    bits.stripMemoHtml(bits.memoForTrackerContext(memo))

  const current = `## TRACKER STATE 0 (Current)\n${asContext(String(settings.currentMemo ?? '')) || '(empty)'}\n\n`

  const depth = (settings.trackerHistoryCount || 1) - 1
  const archived: string[] = Array.isArray(settings.memoHistory) ? settings.memoHistory : []
  if (depth <= 0 || !archived.length) return current

  const included = archived.slice(0, depth).reverse()
  const older = included.map((memo, index) =>
    `## TRACKER STATE ${-(included.length - index)}\n${asContext(String(memo ?? ''))}`,
  ).join('\n\n')
  return `${older}\n\n${current}`
}

/**
 * Split the entire chat into chunks that each fit one request.
 *
 * A full audit re-reads the whole campaign, which is the one tracker operation
 * that cannot assume it fits. Upstream sizes chunks against SillyTavern's
 * `contextSize`; Lumiverse does not expose the assembled context budget to an
 * extension, so `fullAuditMaxTokens` is the lever here rather than a fallback.
 * The 4-chars-per-token estimate is upstream's, kept so chunk boundaries land
 * in the same places.
 */
function chunkWholeChat(
  chat: StMessage[],
  settings: Record<string, any>,
  clean: EngineBits['cleanToolCallMessage'],
): string[][] {
  const budget = Number(settings.fullAuditMaxTokens) || 32000
  const perChunk = Math.max(1000, budget - 3000)

  const chunks: string[][] = []
  let current: string[] = []
  let tokens = 0

  for (const message of chat) {
    const content = clean(message.mes ?? '')
    if (content === null) continue
    const line = `${message.is_user ? 'Player' : (message.name || 'Narrator')}: ${content}`
    const cost = Math.ceil(line.length / 4)

    if (tokens + cost > perChunk && current.length > 0) {
      chunks.push(current)
      current = []
      tokens = 0
    }
    current.push(line)
    tokens += cost
  }
  if (current.length) chunks.push(current)
  return chunks
}

export interface StatePassResult {
  ran: boolean
  changed: boolean
  reason?: string
  delta?: string
}

/**
 * Take a model reply apart: pull out [RELATIONS] commands, unwrap `<memo>`.
 *
 * The relationship block must come off before memo processing — leaving command
 * syntax in the merge would persist it into tracker state.
 */
function parseReply(
  raw: string,
  settings: Record<string, any>,
  bits: EngineBits,
): { memo: string; commands: unknown[] } {
  let commands: unknown[] = []
  let cleaned = raw
  if (relationshipModeActive(settings, bits)) {
    try {
      const extracted = bits.extractStateTrackerRelationshipCommands(raw)
      cleaned = extracted.memo
      commands = extracted.commands ?? []
    } catch (error) {
      spindle.log.warn(`[DnD] relationship extraction failed: ${(error as Error).message}`)
    }
  }

  // The model may wrap its answer in <memo> tags; take the last block.
  const blocks = [...cleaned.matchAll(/<memo>([\s\S]*?)<\/memo>/gi)]
  const memo = blocks.length
    ? blocks[blocks.length - 1][1].trim()
    : cleaned.replace(/<\/?memo>/gi, '').trim()

  return { memo, commands }
}

/**
 * Merge one model reply into the running memo and persist it.
 *
 * Shared by the incremental pass and every chunk of a full audit — an audit
 * chunk is committed as though it were a completed turn, so the next chunk
 * reads the state the previous one produced.
 */
function commitMerge(
  priorMemo: string,
  output: string,
  settings: Record<string, any>,
  bits: EngineBits,
): { changed: boolean; delta: string } {
  // Upstream commits `applyQuestSyncAndStripMemo(merged)`, not the raw merge:
  // it moves quests out of the memo into `settings.quests` and strips archived
  // ones. Without it the quest log never populates and completed quests pile
  // up in the memo forever.
  let merged = bits.mergeMemo(priorMemo, output)
  try {
    merged = bits.applyQuestSyncAndStripMemo(merged) ?? merged
  } catch (error) {
    spindle.log.warn(`[DnD] quest sync failed: ${(error as Error).message}`)
  }
  if (merged === priorMemo) return { changed: false, delta: '' }

  const delta = bits.computeDelta(priorMemo, merged)
  settings.currentMemo = merged
  settings.lastDelta = delta
  settings.memoHistory = [priorMemo, ...(settings.memoHistory ?? [])]
    .slice(0, Math.max(1, settings.trackerHistoryCount ?? 3))

  // `saveChatState` is a no-op without a chat id — it returns before doing
  // anything and reports nothing, so calling it bare loses the commit
  // silently while the in-memory memo still looks correct.
  const commitChatId = chatMirror.getChatId()
  if (!commitChatId) {
    spindle.log.warn('[DnD] no chat id at commit; state kept in memory only')
  } else {
    try {
      bits.saveChatState(commitChatId)
    } catch (error) {
      spindle.log.error(`[DnD] chat state save failed: ${(error as Error).message}`)
    }
  }

  return { changed: true, delta }
}

/**
 * Stamp the swipe-rollback snapshot on the reply this pass just tracked.
 *
 * Upstream's `runStateModelPass` does this after every chunk it commits: the
 * memo before the reply and the memo after it, keyed by the reply's swipe.
 * When the user swipes or regenerates, the engine's interceptor puts the memo
 * back to the "before" for the new swipe — or the "after" of one already
 * tracked — so the new reply is tracked from the state it actually follows.
 *
 * The port replaced `runStateModelPass` and dropped this, so a regenerated
 * reply was tracked on top of the one it replaced: regenerate a hit for 14
 * damage into a hit for 10, and the sheet took 24.
 */
function stampSwipeSnapshot(before: string, settings: Record<string, any>): void {
  if (settings.stateTrackerSwipeRollback === false) return
  const last = [...chatMirror.messages].reverse().find(message => !message.is_user)
  if (!last) return
  const swipe = last.swipe_id ?? 0
  const extra = (last.extra ??= {}) as Record<string, any>
  extra.rpgMemoRollback = { ...(extra.rpgMemoRollback ?? {}), [swipe]: before }
  extra.rpgMemoResult = { ...(extra.rpgMemoResult ?? {}), [swipe]: String(settings.currentMemo ?? '') }
  extra.rpgMemoActiveSwipe = swipe
  // Saved with the message; see the markers in `chat-mirror.ts`.
  chatMirror.markDirty()
  void chatMirror.flush().catch(error => {
    spindle.log.warn(`[DnD] saving the swipe snapshot failed: ${(error as Error).message}`)
  })
}

/** Apply extracted [RELATIONS] commands, never failing the memo commit. */
async function applyCommands(
  commands: unknown[],
  passChatId: string | null,
  bits: EngineBits,
): Promise<void> {
  if (!commands.length) return
  try {
    const outcome = await bits.applyStateTrackerRelationshipCommands(commands, {
      passChatId,
    })
    if (!outcome.applied) {
      spindle.log.info(`[DnD] ${commands.length} relationship command(s) not applied: ${outcome.status}`)
    }
  } catch (error) {
    // Relationship values are an enrichment; a failure here must not undo
    // an otherwise good memo commit.
    spindle.log.warn(`[DnD] applying relationship commands failed: ${(error as Error).message}`)
  }
}

/**
 * Run one incremental tracker pass.
 *
 * Dungeon-map undo snapshots are still not implemented — see PORTING.md.
 */
export async function runStatePass(): Promise<StatePassResult> {
  if (running) return { ran: false, changed: false, reason: 'already running' }

  const bits = await engine()
  const settings = bits.getSettings()

  if (!settings.enabled) return { ran: false, changed: false, reason: 'tracker disabled' }
  if (!spindle.permissions.has('generation')) {
    return { ran: false, changed: false, reason: 'generation permission not granted' }
  }

  const chat = chatMirror.messages
  if (!chat.length) {
    return {
      ran: false,
      changed: false,
      reason: `chat mirror is empty (chatId: ${chatMirror.getChatId() ?? 'none'})`,
    }
  }

  running = true
  controller?.abort()
  controller = new AbortController()
  const { signal } = controller
  const chatIdAtStart = chatMirror.getChatId()

  try {
    // Deterministic housekeeping upstream does before the model call.
    try {
      bits.checkQuestDeadlines?.()
    } catch (error) {
      spindle.log.warn(`[DnD] quest deadline check failed: ${(error as Error).message}`)
    }

    const lines = collectNarrative(chat, settings, bits.cleanToolCallMessage)
    if (!lines.length) return { ran: false, changed: false, reason: 'nothing to analyse' }

    let worldLore = ''
    try {
      worldLore = await bits.buildLorebookContext()
    } catch (error) {
      // Lore context is an enrichment; a failure here must not skip the pass.
      spindle.log.warn(`[DnD] lorebook context failed: ${(error as Error).message}`)
    }

    const priorMemo = String(settings.currentMemo ?? '')
    // Full review mode has its own closing instruction; using the incremental
    // one would ask for a complete memo and then say "only changed sections".
    const suffix = settings.fullReviewStateMode
      ? bits.FULL_REVIEW_USER_PROMPT_SUFFIX
      : (settings.userPromptSuffix || '## OUTPUT ONLY CHANGED SECTIONS:')

    const userPrompt =
      (worldLore ? `${worldLore}\n\n` : '')
      + buildPriorMemoText(settings, bits)
      + `## NARRATIVE HISTORY (Last ${lines.length} messages)\n${lines.join('\n\n')}\n\n`
      + suffix

    const raw = await bits.sendStateRequest(
      settings,
      buildSystemPrompt(settings, bits),
      userPrompt,
      signal,
      { debugSource: 'Tracker' },
    )

    if (signal.aborted) return { ran: false, changed: false, reason: 'aborted' }
    // A chat switch mid-pass means this result belongs to a conversation the
    // user has left; committing it would write one chat's state onto another.
    if (chatMirror.getChatId() !== chatIdAtStart) {
      return { ran: false, changed: false, reason: 'chat changed during pass' }
    }
    if (!raw || typeof raw !== 'string') {
      return {
        ran: false,
        changed: false,
        reason: `state model returned nothing (${typeof raw})`,
      }
    }

    const { memo: output, commands } = parseReply(raw, settings, bits)
    const { changed, delta } = commitMerge(priorMemo, output, settings, bits)
    stampSwipeSnapshot(priorMemo, settings)
    if (!changed) {
      return {
        ran: true,
        changed: false,
        reason: `model replied ${output.length} chars but the merge changed nothing`,
      }
    }

    await applyCommands(commands, chatIdAtStart, bits)

    return { ran: true, changed: true, delta }
  } catch (error) {
    if (signal.aborted) return { ran: false, changed: false, reason: 'aborted' }
    spindle.log.error(`[DnD] state pass failed: ${(error as Error).message}`)
    return { ran: false, changed: false, reason: (error as Error).message }
  } finally {
    running = false
    controller = null
  }
}

export interface FullAuditResult extends StatePassResult {
  /** Chunks the chat was split into. */
  chunks: number
  /** Chunks that reached a commit before the run ended. */
  committed: number
}

/**
 * Rebuild the memo by re-reading the entire chat.
 *
 * The incremental pass only ever sees the last turn, so anything it missed —
 * an item picked up thirty turns ago, an NPC whose name drifted — stays missed
 * forever. An audit is the repair: it walks the whole campaign in
 * context-sized chunks and rewrites the sheet from what actually happened.
 *
 * Each chunk is committed as though it were a completed turn, which is
 * upstream's design and the thing that makes chunking work at all: the next
 * chunk is shown the memo the previous one produced, so the audit accumulates
 * rather than each chunk fighting over the same starting state. It also means
 * an audit interrupted halfway leaves the memo further along, not corrupted.
 *
 * Expensive on purpose — one model call per chunk — so nothing calls this
 * automatically. It is a button.
 */
export async function runFullAudit(
  onProgress?: (done: number, total: number) => void,
): Promise<FullAuditResult> {
  const nothing = { ran: false, changed: false, chunks: 0, committed: 0 }
  if (running) return { ...nothing, reason: 'already running' }

  const bits = await engine()
  const settings = bits.getSettings()

  if (!settings.enabled) return { ...nothing, reason: 'tracker disabled' }
  if (!spindle.permissions.has('generation')) {
    return { ...nothing, reason: 'generation permission not granted' }
  }

  const chat = chatMirror.messages
  if (!chat.length) {
    return { ...nothing, reason: `chat mirror is empty (chatId: ${chatMirror.getChatId() ?? 'none'})` }
  }

  const chunks = chunkWholeChat(chat, settings, bits.cleanToolCallMessage)
  if (!chunks.length) return { ...nothing, reason: 'nothing to analyse' }

  running = true
  controller?.abort()
  controller = new AbortController()
  const { signal } = controller
  const chatIdAtStart = chatMirror.getChatId()

  let committed = 0
  let changedAny = false
  let lastDelta = ''
  let stopped = ''

  try {
    try {
      bits.checkQuestDeadlines?.()
    } catch (error) {
      spindle.log.warn(`[DnD] quest deadline check failed: ${(error as Error).message}`)
    }

    let worldLore = ''
    try {
      worldLore = await bits.buildLorebookContext()
    } catch (error) {
      spindle.log.warn(`[DnD] lorebook context failed: ${(error as Error).message}`)
    }

    const systemPrompt = buildSystemPrompt(settings, bits, true)

    for (let index = 0; index < chunks.length; index++) {
      if (signal.aborted) { stopped = 'aborted'; break }
      if (chatMirror.getChatId() !== chatIdAtStart) {
        stopped = 'chat changed during audit'
        break
      }

      onProgress?.(index, chunks.length)

      // Re-read the committed memo each time rather than a snapshot taken at
      // the start: the previous chunk has already committed, and that result
      // is precisely what this chunk should be correcting.
      const priorMemo = String(settings.currentMemo ?? '')
      const priorForPrompt = bits.stripMemoHtml(bits.memoForTrackerContext(priorMemo))

      const userPrompt =
        (worldLore ? `${worldLore}\n\n` : '')
        + `## PRIOR MEMO\n${priorForPrompt || '(empty)'}\n\n`
        + `## NARRATIVE HISTORY (Chunk ${index + 1} of ${chunks.length})\n${chunks[index].join('\n\n')}\n\n`
        + '## TASK\nAnalyze the narrative chunk provided above. Rebuild the State Memo '
        + 'to ensure every detail is perfectly accurate to this point in the story. '
        + 'Correct any errors or omissions found in the Prior Memo.\n\n'
        + '## OUTPUT THE COMPLETE VERIFIED STATE MEMO:'

      const raw = await bits.sendStateRequest(
        settings, systemPrompt, userPrompt, signal,
        { debugSource: `Tracker full audit ${index + 1}/${chunks.length}` },
      )

      if (signal.aborted) { stopped = 'aborted'; break }
      if (chatMirror.getChatId() !== chatIdAtStart) {
        stopped = 'chat changed during audit'
        break
      }
      if (!raw || typeof raw !== 'string') {
        // One weak chunk should not abandon the rest of the campaign.
        spindle.log.warn(`[DnD] full audit chunk ${index + 1} returned nothing; continuing`)
        continue
      }

      const { memo: output, commands } = parseReply(raw, settings, bits)
      const { changed, delta } = commitMerge(priorMemo, output, settings, bits)
      stampSwipeSnapshot(priorMemo, settings)
      committed++
      if (changed) {
        changedAny = true
        lastDelta = delta
      }
      await applyCommands(commands, chatIdAtStart, bits)
    }

    onProgress?.(committed, chunks.length)

    return {
      ran: committed > 0,
      changed: changedAny,
      delta: lastDelta,
      chunks: chunks.length,
      committed,
      reason: stopped || undefined,
    }
  } catch (error) {
    if (signal.aborted) {
      return { ran: committed > 0, changed: changedAny, chunks: chunks.length, committed, reason: 'aborted' }
    }
    spindle.log.error(`[DnD] full audit failed: ${(error as Error).message}`)
    return {
      ran: committed > 0,
      changed: changedAny,
      chunks: chunks.length,
      committed,
      reason: (error as Error).message,
    }
  } finally {
    running = false
    controller = null
  }
}
