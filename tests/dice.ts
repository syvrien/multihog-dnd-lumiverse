/**
 * dice.ts — the tool-call half of the hybrid RNG.
 *
 *   bun tests/dice.ts
 *
 * The deterministic queue already works: `narrative-hooks.js` injects it from
 * inside the interceptor. This covers the other half — the tools that make the
 * model declare a DC *before* it sees the roll, which is the anti-sycophancy
 * mechanism the framework is built around.
 *
 * It went unnoticed for a while because `registerDiceFunctionTool()` opens with
 *
 *     const { registerFunctionTool, unregisterFunctionTool } = ctx
 *     if (!registerFunctionTool || !unregisterFunctionTool) return
 *
 * so with those missing from the compat context the whole feature returned
 * silently, with nothing logged.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle, invokeTool } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [
  {
    id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
    name: 'You', content: 'I swing at the wolf.', send_date: 0, swipe_id: 0,
    swipes: ['I swing at the wolf.'], swipe_dates: [0], extra: {},
    parent_message_id: null, branch_id: null, created_at: 0,
  },
])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await import('../src/backend')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 400))

/**
 * Dice tools only. `CreateAreaMap` also lives in this registry once Persistent
 * Maps is on, so asserting the registry is *empty* would fail for a reason with
 * nothing to do with dice.
 */
const diceTools = (): string[] =>
  [...state.tools.keys()].filter(name => /roll|dice|rng|d20|d100/i.test(name))

console.log('── defaults ──')
// Both tools ship off, matching the engine defaults.
check('no dice tools registered by default', diceTools().length === 0,
  diceTools().join(', ') || 'none')

console.log('\n── enabling from settings ──')
await emitFrontendMessage(state, {
  type: 'settings:patch',
  patch: { rngToolD20: true },
})
await new Promise(resolve => setTimeout(resolve, 200))

check('RollTheDice registered', state.tools.has('RollTheDice'),
  [...state.tools.keys()].join(', ') || 'none')

const registration = state.tools.get('RollTheDice') as Record<string, any> | undefined
check('declared for inline function calling', registration?.inline_available === true,
  String(registration?.inline_available))
check('carries a JSON schema', !!registration?.parameters?.properties,
  Object.keys(registration?.parameters?.properties ?? {}).join(', '))
check('requires a DC up front',
  (registration?.parameters?.required ?? []).includes('dc'),
  JSON.stringify(registration?.parameters?.required))

console.log('\n── invocation ──')
const result = await invokeTool(state, 'RollTheDice', {
  who: 'Kestrel', for: 'attack', formula: '1d20+5', dc: 12,
})
check('returned a result string', typeof result === 'string' && result.length > 0,
  result.slice(0, 90))
check('named the roller', result.includes('Kestrel'))
check('echoed the formula', result.includes('1d20+5'))
check('stated the DC', result.includes('12'))
check('adjudicated the outcome',
  result.includes('SUCCESS') || result.includes('FAILURE'),
  result.slice(-40))

console.log('\n── d100 tool ──')
await emitFrontendMessage(state, {
  type: 'settings:patch',
  patch: { rngToolD100: true },
})
await new Promise(resolve => setTimeout(resolve, 200))
check('RollTheDiceD100 registered', state.tools.has('RollTheDiceD100'),
  [...state.tools.keys()].join(', '))

const d100 = await invokeTool(state, 'RollTheDiceD100', {
  who: 'Kestrel', for: 'ambush chance', formula: '1d100', dc: 35,
})
check('d100 uses roll-under semantics',
  d100.includes('HIT') || d100.includes('MISS'), d100.slice(-40))

console.log('\n── disabling ──')
await emitFrontendMessage(state, {
  type: 'settings:patch',
  patch: { rngToolD20: false, rngToolD100: false },
})
await new Promise(resolve => setTimeout(resolve, 200))
check('tools removed from the host registry', diceTools().length === 0,
  diceTools().join(', ') || 'none')

console.log('\n── unknown tool ──')
const unknown = await invokeTool(state, 'NotARealTool', {})
check('unknown invocation returns empty rather than throwing', unknown === '',
  JSON.stringify(unknown))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)

console.log(`\n${failures === 0 ? 'dice test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
