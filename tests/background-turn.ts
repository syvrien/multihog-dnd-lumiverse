/**
 * background-turn.ts — a reply that finishes in a chat you have left.
 *
 *   bun tests/background-turn.ts
 *
 * Lumiverse generates on the server, detached from the page: send a message,
 * open another chat, and the reply keeps streaming and lands where it was
 * asked for. GENERATION_ENDED then names that chat. The port answered it by
 * switching the tracker to that chat — so the panel in front of the user now
 * showed another campaign, and anything they did there landed in it. SillyTavern
 * stops a generation when you change chats, so upstream never had the case.
 *
 * The turn's update is not lost, only postponed: it runs when the user goes
 * back, against the chat it belongs to, provided the reply it was for is still
 * that chat's latest.
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const msg = (chatId: string, id: string, idx: number, user: boolean, text: string): Record<string, unknown> => ({
  id, chat_id: chatId, index_in_chat: idx,
  is_user: user, role: user ? 'user' : 'assistant',
  name: user ? 'You' : 'Narrator',
  content: text, send_date: 0, swipe_id: 0, swipes: [text], swipe_dates: [0],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})
state.messages.set('chat-a', [
  msg('chat-a', 'a1', 0, true, 'I fight the wolf.'),
  msg('chat-a', 'a2', 1, false, 'The wolf bites deep. You take 14 damage.'),
] as never)
state.messages.set('chat-b', [
  msg('chat-b', 'b1', 0, true, 'I open the door.'),
  msg('chat-b', 'b2', 1, false, 'It creaks.'),
] as never)
const MEMO_A = '[CHARACTER]\nName: Kestrel\nClass: Ranger\nHP: 34/34\n[/CHARACTER]'
const MEMO_B = '[CHARACTER]\nName: Bram\nClass: Cleric\nHP: 22/22\n[/CHARACTER]'
// What the state model returns for chat A's turn.
state.generationResponse = '[CHARACTER]\nName: Kestrel\nClass: Ranger\nHP: 20/34\n[/CHARACTER]'

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
  await wait(500)
}
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const extractorCalls = (): number => (state.generations as unknown[]).filter(entry =>
  /State Extractor/.test(String((entry as any)?.messages?.[0]?.content ?? ''))).length
const memoOf = (chatId: string): string => String(settings.chatStates?.[chatId]?.currentMemo ?? '')
const toasts = (): string[] => state.toFrontend
  .filter(m => (m as any).type === 'toast').map(m => String((m as any).message))

// Two campaigns, each saved with its own chat.
await go('chat-a')
settings.currentMemo = MEMO_A
await go('chat-b')
settings.currentMemo = MEMO_B
await go('chat-a')
check('fixture: each chat has its own campaign',
  /Kestrel/.test(String(settings.currentMemo)) && /Bram/.test(memoOf('chat-b')))

console.log('── the open chat\'s own turn ──')
let calls = extractorCalls()
await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-a', messageId: 'a2', generationType: 'normal' })
await wait(800)
check('runs the tracker straight away, as before', extractorCalls() === calls + 1)
check('and updates that campaign', /HP: 20\/34/.test(String(settings.currentMemo)))

// Reset A's HP for the background scenario.
settings.currentMemo = MEMO_A
state.messages.get('chat-a')!.push(
  msg('chat-a', 'a3', 2, true, 'I bandage the wound and keep going.') as never,
  msg('chat-a', 'a4', 3, false, 'A second wolf lunges. You take 14 damage.') as never,
)
await chatMirror.refresh()

console.log('\n── a reply lands after you have left ──')
await go('chat-b')
calls = extractorCalls()
state.toFrontend.length = 0
await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-a', messageId: 'a4', generationType: 'normal' })
await wait(900)
check('the tracker stays on the chat you are in', chatMirror.getChatId() === 'chat-b', String(chatMirror.getChatId()))
check('showing that chat\'s campaign', /Bram/.test(String(settings.currentMemo)),
  String(settings.currentMemo).split('\n')[1])
check('no tracker pass runs against the wrong chat', extractorCalls() === calls,
  `${extractorCalls() - calls} pass(es)`)
check('the other campaign is untouched for now', /HP: 34\/34/.test(memoOf('chat-a')),
  memoOf('chat-a').match(/HP: [^\n]*/)?.[0])
check('and you are told it is waiting', toasts().some(t => /reply finished in/i.test(t)), toasts().join(' | '))

console.log('\n── going back ──')
await go('chat-a')
await wait(800)
check('the postponed update runs there', extractorCalls() === calls + 1, `${extractorCalls() - calls} pass(es)`)
check('against the right campaign', /Kestrel/.test(String(settings.currentMemo))
  && /HP: 20\/34/.test(String(settings.currentMemo)), String(settings.currentMemo).match(/HP: [^\n]*/)?.[0])
check('leaving the other alone', /Bram/.test(memoOf('chat-b')) && /HP: 22\/22/.test(memoOf('chat-b')))
await go('chat-b')
await go('chat-a')
check('and only once', extractorCalls() === calls + 1, `${extractorCalls() - calls} pass(es)`)

console.log('\n── a reply that is no longer the latest ──')
await go('chat-b')
calls = extractorCalls()
await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-a', messageId: 'a4', generationType: 'normal' })
await wait(500)
// Meanwhile the user's reply in A was regenerated: a4 is gone.
state.messages.get('chat-a')!.pop()
state.messages.get('chat-a')!.push(msg('chat-a', 'a5', 3, false, 'The wolf retreats.') as never)
await go('chat-a')
await wait(600)
check('is not tracked against whatever replaced it', extractorCalls() === calls, `${extractorCalls() - calls} pass(es)`)

console.log('\n── nothing to wait for ──')
// One at a time: a chat keeps one postponed turn, so a second event would
// overwrite the first and hide whether it was handled.
for (const [label, payload] of [
  ['a failed generation', { chatId: 'chat-a', error: 'provider timed out', generationType: 'normal' }],
  ['a quiet generation', { chatId: 'chat-a', messageId: 'a5', generationType: 'quiet' }],
] as const) {
  await go('chat-b')
  calls = extractorCalls()
  state.toFrontend.length = 0
  await emitHostEvent(state, 'GENERATION_ENDED', payload)
  await wait(600)
  check(`${label} elsewhere is not announced`, !toasts().some(t => /reply finished in/i.test(t)),
    toasts().join(' | '))
  await go('chat-a')
  await wait(600)
  check('nor tracked on return', extractorCalls() === calls, `${extractorCalls() - calls} pass(es)`)
}

console.log('\n── a chat deleted before you return ──')
await go('chat-b')
calls = extractorCalls()
await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-a', messageId: 'a5', generationType: 'normal' })
await wait(300)
state.deletedChats.add('chat-a')
await emitHostEvent(state, 'CHAT_DELETED', { id: 'chat-a' })
await wait(600)
check('never has its turn tracked', extractorCalls() === calls, `${extractorCalls() - calls} pass(es)`)

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'background turn test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
