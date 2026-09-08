/**
 * editing.ts — correcting tracker state by hand or by asking the model.
 *
 *   bun tests/editing.ts
 *
 * The panel was read-only until now, which meant a wrong HP or an invented item
 * could not be fixed. Both routes commit through the same merge and persistence
 * path as an automatic pass, so this checks that equivalence rather than just
 * "the button does something".
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [
  {
    id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
    name: 'You', content: 'I drink the potion.', send_date: 0, swipe_id: 0,
    swipes: ['I drink the potion.'], swipe_dates: [0], extra: {},
    parent_message_id: null, branch_id: null, created_at: 0,
  },
])

const MEMO = `[TIME]
Day 1, 10:00
[/TIME]
[CHARACTER]
Name: Kestrel
HP: 4/34
[/CHARACTER]`

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await import('../src/backend')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 400))

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
settings.currentMemo = MEMO

const { readMemo, writeMemo, askTracker } = await import('../src/tracker/direct-prompt')

console.log('── raw editing ──')
check('reads the current memo back', (await readMemo()).includes('HP: 4/34'))

const edited = MEMO.replace('HP: 4/34', 'HP: 30/34')
const write = await writeMemo(edited)
check('accepted the edit', write.ok && write.changed, JSON.stringify(write))
check('memo took the hand edit', String(settings.currentMemo).includes('HP: 30/34'),
  String(settings.currentMemo).match(/HP: [^\n]*/)?.[0] ?? '')
check('prior memo pushed to history',
  Array.isArray(settings.memoHistory) && settings.memoHistory[0] === MEMO,
  `history ${settings.memoHistory?.length ?? 0}`)
check('delta recorded', !!String(settings.lastDelta ?? '').trim())

const unchanged = await writeMemo(String(settings.currentMemo))
check('an identical edit is not a change', unchanged.ok && !unchanged.changed,
  JSON.stringify(unchanged))

console.log('\n── asking the tracker ──')
state.generationResponse = `[CHARACTER]
Name: Kestrel
HP: 34/34
[/CHARACTER]`

const before = state.generations.length
const ask = await askTracker('Kestrel drank a full heal — set HP to maximum.')
check('reached the model', state.generations.length > before,
  `${state.generations.length - before} request(s)`)
check('reported success', ask.ok && ask.changed, JSON.stringify(ask))
check('memo took the correction', String(settings.currentMemo).includes('HP: 34/34'),
  String(settings.currentMemo).match(/HP: [^\n]*/)?.[0] ?? '')
check('unrelated section preserved', String(settings.currentMemo).includes('[TIME]'))

const request = state.generations[state.generations.length - 1] as {
  messages?: Array<{ role: string; content: string }>
}
const prompt = (request?.messages ?? []).map(m => m.content).join('\n')
check('instruction reached the prompt', prompt.includes('full heal'))
check('prior memo reached the prompt', prompt.includes('Kestrel'))
check('recent narrative reached the prompt', prompt.includes('drink the potion'))

console.log('\n── empty instruction ──')
const empty = await askTracker('   ')
check('an empty instruction is refused, not sent',
  !empty.ok && empty.reason === 'nothing to ask', JSON.stringify(empty))

console.log('\n── persistence ──')
await new Promise(resolve => setTimeout(resolve, 1200))
const key = [...state.userStorage.keys()].find(k => k.endsWith('settings.json'))
check('settings written to per-user storage', !!key)
if (key) {
  const saved = JSON.parse(state.userStorage.get(key)!).rpg_tracker ?? {}
  check('edited memo survived to storage',
    String(saved.currentMemo ?? '').includes('HP: 34/34'),
    String(saved.currentMemo ?? '').match(/HP: [^\n]*/)?.[0] ?? 'not persisted')
}

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'editing test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
