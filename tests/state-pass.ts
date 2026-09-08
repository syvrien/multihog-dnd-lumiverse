/**
 * state-pass.ts — functional check of the tracker's second-pass model call.
 *
 *   bun tests/state-pass.ts
 *
 * The state pass is the one piece rebuilt rather than ported, so it needs its
 * own coverage: does it read the right slice of chat, does it reach the model
 * with a usable prompt, and does the model's reply actually land in the memo.
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()

const MEMO = `[TIME]
Day 3, 14:20
[/TIME]
[CHARACTER]
Name: Kestrel
Class: Ranger
Level: 4
HP: 27/34
[/CHARACTER]`

const msg = (id: string, idx: number, user: boolean, text: string): Record<string, unknown> => ({
  id, chat_id: 'chat-1', index_in_chat: idx,
  is_user: user, role: user ? 'user' : 'assistant',
  name: user ? 'You' : 'Narrator',
  content: text, send_date: 0, swipe_id: 0, swipes: [text], swipe_dates: [0],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})

state.messages.set('chat-1', [
  msg('m1', 0, true, 'I check my pack.'),
  msg('m2', 1, false, 'Rope, a torch, and half a loaf.'),
  msg('m3', 2, true, 'I fight the wolf.'),
  msg('m4', 3, false, 'The wolf bites deep. You take 7 damage and it flees into the dark.'),
])

// What the state model "returns" — the changed section only, as upstream asks.
state.generationResponse = `[CHARACTER]
Name: Kestrel
Class: Ranger
Level: 4
HP: 20/34
[/CHARACTER]`

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await import('../src/backend')

// Operator-scoped: user-scoped startup (chat sync, connection adoption) is
// deferred until an event names a user. Nothing happens without this.
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 400))

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
settings.currentMemo = MEMO

console.log('── connection ──')
check('single connection adopted automatically',
  settings.connectionProfileId === 'conn-1',
  `source=${settings.connectionSource} id=${settings.connectionProfileId}`)

console.log('\n── state pass ──')
const { runStatePass } = await import('../src/tracker/state-pass')
const before = state.generations.length
const result = await runStatePass()

check('pass ran', result.ran, result.reason ?? '')
check('reached the model', state.generations.length > before,
  `${state.generations.length - before} request(s)`)

const request = state.generations[state.generations.length - 1] as {
  messages?: Array<{ role: string; content: string }>
  connection_id?: string
  model?: string
  provider?: string
}
const prompt = (request?.messages ?? []).map(m => m.content).join('\n')

check('used the configured connection', request?.connection_id === 'conn-1',
  String(request?.connection_id))
// `connection_id` alone is not enough: the host forwards `provider`/`model`
// verbatim, so omitting them 400s at the provider.
check('resolved the model from the connection profile',
  request?.model === 'z-ai/glm-5.3-flash-uncensored', String(request?.model))
check('resolved the provider from the connection profile',
  request?.provider === 'nanogpt', String(request?.provider))
check('prompt carried the prior memo', prompt.includes('Kestrel'))
check('prompt carried the recent narrative', prompt.includes('wolf bites deep'))
check('prompt excluded the older turn', !prompt.includes('half a loaf'),
  'lookback should start at the last user message')

console.log('\n── commit ──')
check('memo changed', result.changed, `changed=${result.changed}`)
check('HP updated in the memo', String(settings.currentMemo).includes('HP: 20/34'),
  String(settings.currentMemo).match(/HP: [^\n]*/)?.[0] ?? 'no HP line')
check('unrelated section preserved', String(settings.currentMemo).includes('[TIME]'))
check('prior memo pushed to history',
  Array.isArray(settings.memoHistory) && settings.memoHistory[0] === MEMO,
  `history length ${settings.memoHistory?.length ?? 0}`)
check('delta recorded', !!String(settings.lastDelta ?? '').trim())

console.log('\n── persistence ──')
// The engine commits through runtime-bridge actions installed by the entry
// point. With that table unfilled, `saveChatState()` throws and the memo lives
// only in memory — the panel looks correct and everything is lost on restart.
check('no runtime action was called before initialisation',
  !state.logs.some(l => /used before initialization/i.test(l.message)),
  state.logs.find(l => /used before initialization/i.test(l.message))?.message ?? '')

console.log('\n── how often the pass runs ──')
/*
 * The tracker is the one model call that happens on every single turn, so how
 * often it runs is the largest latency control the extension has. The engine
 * has always throttled it on `stateTrackerRunEvery` — `onGenerationEnded`
 * skips the pass on non-matching ticks — but the port never put the setting in
 * the schema, so it sat at its default of 1 and could not be changed.
 */
const extractorCalls = (): number => (state.generations as unknown[]).filter(entry =>
  /State Extractor/.test(String((entry as any)?.messages?.[0]?.content ?? ''))).length

const turnsToRun = async (every: number, turns: number): Promise<number> => {
  settings.stateTrackerRunEvery = every
  state.generations.length = 0
  for (let turn = 0; turn < turns; turn++) {
    await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-1' })
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return extractorCalls()
}

const everyTurn = await turnsToRun(1, 8)
check('the default runs a pass on every turn', everyTurn === 8, `${everyTurn} of 8`)
const everyOther = await turnsToRun(2, 8)
check('raising it halves the model calls', everyOther === 4, `${everyOther} of 8`)
check('which is the point: fewer passes, fewer waits',
  everyOther < everyTurn, `${everyOther} vs ${everyTurn}`)
settings.stateTrackerRunEvery = 1

// The control has to be reachable, not just honoured — this is what was missing.
const { SETTINGS_SCHEMA } = await import('../src/shared/settings-schema')
const exposed = SETTINGS_SCHEMA.some(area =>
  (area.fields ?? []).some(field => field.key === 'stateTrackerRunEvery')
  || (area.groups ?? []).some(group =>
    group.fields.some(field => field.key === 'stateTrackerRunEvery')))
check('and it is offered in the settings', exposed,
  'the engine honoured it all along; nothing exposed it')

// Settings are saved debounced; give the timer room to fire.
await new Promise(resolve => setTimeout(resolve, 1200))

const settingsKey = [...state.userStorage.keys()].find(k => k.endsWith('settings.json'))
check('settings written to per-user storage', !!settingsKey,
  [...state.userStorage.keys()].join(', ') || 'nothing written')

if (settingsKey) {
  const saved = JSON.parse(state.userStorage.get(settingsKey)!).rpg_tracker ?? {}
  check('memo survived to storage', String(saved.currentMemo ?? '').includes('HP: 20/34'),
    String(saved.currentMemo ?? '').match(/HP: [^\n]*/)?.[0] ?? 'no memo persisted')
}

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)

console.log(`\n${failures === 0 ? 'state pass test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
