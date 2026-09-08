/**
 * tracker.ts — functional check of the State Tracker path.
 *
 *   bun tests/tracker.ts
 *
 * smoke.ts proves the backend boots. This proves the two things the tracker
 * actually has to do: turn a state memo into panel markup, and inject that memo
 * into an outgoing prompt.
 */

import { installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [
  { id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user', name: 'You', content: 'I check my pack.', send_date: 0, swipe_id: 0, swipes: ['I check my pack.'], swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0 },
  { id: 'm2', chat_id: 'chat-1', index_in_chat: 1, is_user: false, role: 'assistant', name: 'Narrator', content: 'Rope, a torch, and half a loaf.', send_date: 0, swipe_id: 0, swipes: ['Rope, a torch, and half a loaf.'], swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0 },
])

const MEMO = `[TIME]
Day 3, 14:20
[/TIME]
[CHARACTER]
Name: Kestrel
Class: Ranger
Level: 4
HP: 27/34
[/CHARACTER]
[INVENTORY]
Gear:
- 🪢 Rope (50 ft)
- 🔥 Torch
- 🍞 Rations
[/INVENTORY]`

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await import('../src/backend')
await new Promise(resolve => setTimeout(resolve, 250))

// The engine owns its settings tree; write the memo the way the tracker would.
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

console.log('── engine settings ──')
check('engine getSettings() returned a tree', Object.keys(settings).length > 0,
  `${Object.keys(settings).length} keys`)
check('tracker enabled by default', settings.enabled === true, String(settings.enabled))

settings.currentMemo = MEMO

console.log('\n── panel render ──')
const { renderMemoAsCards, parseMemoBlocks } = await import('../src/engine/renderer.js') as {
  renderMemoAsCards: (
    memo: string,
    filterTag: string | null,
    sectionPages: Record<string, unknown>,
    uiOptions?: Record<string, unknown>,
  ) => string
  parseMemoBlocks: (memo: string) => unknown
}
const { sectionPages } = await import('../src/engine/src/app/runtime-bridge.js') as {
  sectionPages: Record<string, unknown>
}

const blocks = parseMemoBlocks(MEMO)
check('memo parsed into blocks', !!blocks && Object.keys(blocks as object).length > 0,
  `${Object.keys((blocks ?? {}) as object).join(', ')}`)

let html = ''
try {
  html = renderMemoAsCards(MEMO, null, sectionPages)
  check('renderer produced markup', html.length > 0, `${html.length} chars`)
  check('character name rendered', html.includes('Kestrel'))
  check('inventory item rendered', html.includes('Rope'))
} catch (error) {
  check('renderer ran', false, (error as Error).message)
}

console.log('\n── prompt injection ──')
const { handler } = state.interceptors[0] ?? {}
if (!handler) {
  check('interceptor available', false)
} else {
  const prompt = [
    { role: 'system', content: 'You are the narrator.' },
    { role: 'user', content: 'I check my pack.' },
  ]
  try {
    const result = await handler(prompt, {
      chatId: 'chat-1', generationType: 'normal', userId: state.userId,
    })
    const joined = result.map((m: { content: string }) => m.content).join('\n')
    check('interceptor returned messages', Array.isArray(result), `${result.length} messages`)
    check('state memo reached the prompt', joined.includes('Kestrel'),
      joined.includes('Kestrel') ? '' : `no memo in ${result.length} messages`)
  } catch (error) {
    check('interceptor ran', false, (error as Error).message)
  }
}

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)

console.log(`\n${failures === 0 ? 'tracker test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
