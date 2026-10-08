/**
 * relationships.ts — relationship commands through the State Tracker pass.
 *
 *   bun tests/relationships.ts
 *
 * In State Tracker mode the state model emits `[RELATIONS]` blocks alongside
 * the memo. Three things have to happen and each fails silently on its own:
 *
 *   1. the system prompt must teach the command syntax, or the model never
 *      emits any and the feature looks enabled while doing nothing
 *   2. the blocks must be stripped *before* the memo merge, or command syntax
 *      is persisted into tracker state
 *   3. the commands must be applied after the commit
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()

const msg = (id: string, i: number, user: boolean, text: string): Record<string, unknown> => ({
  id, chat_id: 'chat-1', index_in_chat: i, is_user: user,
  role: user ? 'user' : 'assistant', name: user ? 'You' : 'Narrator',
  content: text, send_date: 0, swipe_id: 0, swipes: [text], swipe_dates: [0],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})

state.messages.set('chat-1', [
  msg('m1', 0, true, 'I share my rations with Tiktik.'),
  msg('m2', 1, false, 'Tiktik accepts, visibly moved.'),
])

const MEMO = `[TIME]
Day 1, 18:00
[/TIME]
[CHARACTER]
Name: Kestrel
HP: 10/10
[/CHARACTER]`

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await import('../src/backend')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 400))

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
settings.currentMemo = MEMO
settings.npcRelationshipBars = true
settings.npcRelationshipUpdateMode = 'state_tracker'

const { runStatePass } = await import('../src/tracker/state-pass')

console.log('── prompt ──')
// The model replies with a memo section plus a relationship block.
state.generationResponse = `[CHARACTER]
Name: Kestrel
HP: 9/10
[/CHARACTER]
[RELATIONS]
Tiktik | friendship +5 | shared rations
[/RELATIONS]`

const result = await runStatePass()
check('pass ran', result.ran, result.reason ?? '')

const request = state.generations[state.generations.length - 1] as {
  messages?: Array<{ role: string; content: string }>
}
const systemPrompt = (request?.messages ?? [])
  .filter(m => m.role === 'system').map(m => m.content).join('\n')
// Assert on a phrase unique to the instruction builder, not just "RELATIONS",
// which also appears elsewhere in the template.
check('system prompt taught the command syntax',
  systemPrompt.includes('RELATIONSHIP DELTA COMMANDS'),
  systemPrompt.includes('RELATIONSHIP DELTA COMMANDS')
    ? `${systemPrompt.length} chars`
    : 'instruction missing from the system prompt')

console.log('\n── memo hygiene ──')
const memo = String(settings.currentMemo ?? '')
check('memo took the model update', memo.includes('HP: 9/10'),
  memo.match(/HP: [^\n]*/)?.[0] ?? 'no HP line')
check('command syntax kept out of the memo', !/\[RELATIONS\]/i.test(memo),
  memo.includes('[RELATIONS]') ? 'RELATIONS block leaked into tracker state' : '')
check('unrelated section preserved', memo.includes('[TIME]'))

console.log('\n── regex mode leaves the reply alone ──')
settings.npcRelationshipUpdateMode = 'regex'
settings.currentMemo = MEMO
state.generationResponse = `[CHARACTER]
Name: Kestrel
HP: 8/10
[/CHARACTER]`
await runStatePass()
const regexRequest = state.generations[state.generations.length - 1] as {
  messages?: Array<{ role: string; content: string }>
}
const regexPrompt = (regexRequest?.messages ?? [])
  .filter(m => m.role === 'system').map(m => m.content).join('\n')
check('no relationship instruction in narrator-output mode',
  !regexPrompt.includes('RELATIONSHIP DELTA COMMANDS'),
  regexPrompt.includes('RELATIONSHIP DELTA COMMANDS')
    ? 'instruction leaked into regex mode'
    : `${regexPrompt.length} chars, instruction absent as expected`)
check('memo still updates', String(settings.currentMemo).includes('HP: 8/10'),
  String(settings.currentMemo).match(/HP: [^\n]*/)?.[0] ?? '')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'relationships test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
