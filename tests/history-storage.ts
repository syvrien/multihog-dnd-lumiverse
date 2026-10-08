/**
 * history-storage.ts — campaign history persists while file storage is absent.
 *
 *   bun tests/history-storage.ts
 *
 * Upstream 2026.9 moved memo and map history out of `settings.json` into
 * uploaded files (`history-file-storage.js`), through SillyTavern's
 * `/api/files/*` endpoints and an attachment registry. None of that exists in
 * Lumiverse, so every upload reaches `getRequestHeaders()`, which the port
 * deliberately throws on — and upstream's own catch path then exposes the
 * histories again and keeps them inline. That fallback is what this port runs
 * on, so it is pinned here rather than trusted:
 *
 *   - the history stays in the chat partition and is saved with it
 *   - no file pointer is ever recorded, so nothing later tries to read one
 *   - it survives storage and a chat round trip
 *
 * Note what was *not* used: `blockHistoryPersistence()` looks like the off
 * switch and is not. `saveChatState()` and `saveProfile()` both return early
 * when it is set — it is an emergency brake on all saving, and calling it to
 * "turn file storage off" would have stopped every chat from persisting.
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const msg = (chatId: string): never => ([{
  id: 'm-' + chatId, chat_id: chatId, index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'x', send_date: 0, swipe_id: 0, swipes: ['x'],
  swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
}] as never)
state.messages.set('chat-1', msg('chat-1'))
state.messages.set('chat-2', msg('chat-2'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await wait(700)
const { chatMirror } = await import('../src/compat/chat-mirror')
const go = async (id: string): Promise<void> => {
  await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: id })
  for (let i = 0; i < 200 && chatMirror.getChatId() !== id; i++) await wait(5)
  await wait(300)
}
await go('chat-1')

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const { writeMemo } = await import('../src/tracker/direct-prompt')

console.log('── history is kept inline ──')
for (const hp of [8, 7, 6]) {
  await writeMemo(`[CHARACTER]\nSyg (Resonator)\nHP: ${hp}/8\n[/CHARACTER]`)
  await wait(200)
}
const part = settings.chatStates?.['chat-1'] ?? {}
check('the chat partition holds its history',
  Array.isArray(part.memoHistory) && part.memoHistory.length >= 3,
  `${Array.isArray(part.memoHistory) ? part.memoHistory.length : 'no'} snapshot(s)`)
// `concealHistories` makes the arrays non-enumerable after a successful upload
// so they drop out of the saved JSON. Left concealed after a *failed* one, the
// history would vanish on the next save — which is exactly what to rule out.
check('and it is enumerable, so it is saved with the partition',
  Object.getOwnPropertyDescriptor(part, 'memoHistory')?.enumerable === true)
check('no file pointer was recorded',
  !part.historyStorage && !settings.globalHistoryStorage,
  JSON.stringify(part.historyStorage ?? settings.globalHistoryStorage ?? null))

console.log('\n── and it survives ──')
await wait(1500)
const key = [...state.userStorage.keys()].find(k => k.endsWith('settings.json'))
const saved = key ? JSON.parse(state.userStorage.get(key)!) : null
const savedPart = saved?.rpg_tracker?.chatStates?.['chat-1']
check('the history reached storage',
  Array.isArray(savedPart?.memoHistory) && savedPart.memoHistory.length >= 3,
  Array.isArray(savedPart?.memoHistory) ? `${savedPart.memoHistory.length} snapshot(s)` : 'missing')

await go('chat-2')
await go('chat-1')
check('and a chat round trip',
  Array.isArray(settings.memoHistory) && settings.memoHistory.length >= 3,
  Array.isArray(settings.memoHistory) ? `${settings.memoHistory.length} snapshot(s)` : 'missing')
check('with the live memo intact',
  /HP: 6\/8/.test(String(settings.currentMemo)),
  String(settings.currentMemo).match(/HP: [^\n]*/)?.[0] ?? '(none)')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'history storage test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
