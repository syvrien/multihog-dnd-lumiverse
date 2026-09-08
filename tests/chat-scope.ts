/**
 * chat-scope.ts — tracker state belongs to a chat, not to the extension.
 *
 *   bun tests/chat-scope.ts
 *
 * The engine has always stored state per chat under `settings.chatStates[id]`,
 * and `settings.currentMemo` is a *projection* of whichever chat is active.
 * The port called `saveChatState()` and never the loader, so:
 *
 *   - opening a second chat showed the first chat's character
 *   - the next commit wrote that character into the second chat's partition
 *
 * Characters were effectively global, and switching chats could overwrite one
 * campaign with another. This pins the behaviour down.
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()

const msg = (id: string, chat: string, text: string): Record<string, unknown> => ({
  id, chat_id: chat, index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: text, send_date: 0, swipe_id: 0, swipes: [text],
  swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})

state.messages.set('chat-1', [msg('m1', 'chat-1', 'Syg enters the academy.')])
state.messages.set('chat-2', [msg('m2', 'chat-2', 'Vex picks a lock.')])

const SYG = `[CHARACTER]
Syg (Resonator)
HP: 8/8
[/CHARACTER]`

const VEX = `[CHARACTER]
Vex (Rogue)
HP: 14/14
[/CHARACTER]`

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await import('../src/backend')

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const { writeMemo } = await import('../src/tracker/direct-prompt')

console.log('── chat 1 ──')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 300))
await writeMemo(SYG)
const settings = getSettings()
check('chat 1 holds its character', String(settings.currentMemo).includes('Syg'),
  String(settings.currentMemo).slice(0, 30).replace(/\n/g, ' '))
check('saved into chat 1 partition',
  String(settings.chatStates?.['chat-1']?.currentMemo ?? '').includes('Syg'))

console.log('\n── switching to chat 2 ──')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-2' })
await new Promise(resolve => setTimeout(resolve, 400))

// A brand-new chat has no snapshot, so the live projection is whatever was
// there. What must NOT happen is chat 1's state being written into chat 2.
await writeMemo(VEX)
check('chat 2 holds its own character', String(settings.currentMemo).includes('Vex'),
  String(settings.currentMemo).slice(0, 30).replace(/\n/g, ' '))
check('saved into chat 2 partition',
  String(settings.chatStates?.['chat-2']?.currentMemo ?? '').includes('Vex'))
check('chat 1 partition untouched by chat 2 work',
  String(settings.chatStates?.['chat-1']?.currentMemo ?? '').includes('Syg')
    && !String(settings.chatStates?.['chat-1']?.currentMemo ?? '').includes('Vex'),
  'one campaign must not overwrite another')

console.log('\n── back to chat 1 ──')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 400))
check('chat 1 character restored on return',
  String(settings.currentMemo).includes('Syg'),
  String(settings.currentMemo).slice(0, 30).replace(/\n/g, ' '))
check('chat 2 character is gone from the live view',
  !String(settings.currentMemo).includes('Vex'))

console.log('\n── and back again ──')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-2' })
await new Promise(resolve => setTimeout(resolve, 400))
check('chat 2 character restored', String(settings.currentMemo).includes('Vex'),
  String(settings.currentMemo).slice(0, 30).replace(/\n/g, ' '))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'chat scope test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
