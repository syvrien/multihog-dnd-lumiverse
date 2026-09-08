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

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

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

/*
 * The same rule, for work that is still in flight.
 *
 * Everything above is about state at rest. These two are about the gap between
 * starting something and writing its result: both took seconds of model time,
 * and neither noticed a chat switch inside that gap. Each resolved its target
 * when it wrote rather than when it started, so the result landed wherever the
 * user happened to be.
 */
console.log('\n── a roll approved after switching chats ──')
// Deliberately a third character: rolling the one chat 2 already holds would
// make the comparison below true whether or not anything was overwritten.
const BRAM = `[CHARACTER]
Bram (Innkeeper)
HP: 6/6
[/CHARACTER]`
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 400))
state.generationQueue = [BRAM]
await emitFrontendMessage(state, { type: 'roll:go', className: 'Rogue', genre: 'fantasy' })
await new Promise(resolve => setTimeout(resolve, 400))
// Rolled in chat 1; approved while chat 2 is open.
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-2' })
await new Promise(resolve => setTimeout(resolve, 400))
const chat2Before = String(settings.currentMemo)
check('chat 2 is holding its own character to begin with',
  chat2Before.includes('Vex'), chat2Before.slice(0, 30).replace(/\n/g, ' '))
await emitFrontendMessage(state, { type: 'roll:commit', memo: BRAM })
await new Promise(resolve => setTimeout(resolve, 400))
// `writeMemo` replaces the active chat's memo, so this overwrote a campaign
// the rolled character has nothing to do with.
check('the other campaign’s memo survives',
  String(settings.currentMemo) === chat2Before && !String(settings.currentMemo).includes('Bram'),
  String(settings.currentMemo).slice(0, 30).replace(/\n/g, ' '))

console.log('\n── Instant Action interrupted by a chat switch ──')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 400))
const { runQuickStart } = await import('../src/tracker/quickstart')
state.generationQueue = [VEX, 'A quiet thief who counts doors.']
const before2 = state.messages.get('chat-2')?.length ?? 0
let openingSentTo: string | null = null
// The switch happens *inside* the first model call, which is where a real one
// happens. A timer here would be a race the fake usually wins.
state.duringGeneration = async () => {
  state.duringGeneration = undefined
  await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-2' })
}
const outcome = await runQuickStart({ genre: 'fantasy' }, async () => {
  openingSentTo = (await import('../src/compat/chat-mirror')).chatMirror.getChatId()
}, () => {})
await new Promise(resolve => setTimeout(resolve, 400))
check('the roll is abandoned rather than misdelivered',
  !outcome.ok, outcome.reason ?? 'it reported success')
// Both writes happen after the two model calls, so both used to land in
// whichever chat was open by then.
check('no player card was stored in the chat switched to',
  !settings.chatStates?.['chat-2']?.playerCharacter,
  JSON.stringify(settings.chatStates?.['chat-2']?.playerCharacter ?? null))
check('and no opening message was sent to it',
  openingSentTo === null && (state.messages.get('chat-2')?.length ?? 0) === before2,
  String(openingSentTo))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'chat scope test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
