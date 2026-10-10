/**
 * view-chat.ts — the tracker follows the chat the user is looking at.
 *
 *   bun tests/view-chat.ts
 *
 * Reported: "the tracker can't see the chat id" — Update state answering
 * "chat mirror is empty (chatId: none)" with a chat plainly open.
 *
 * Lumiverse's CHAT_SWITCHED is not "this tab opened a chat". It is the
 * account's `activeChatId` setting being written, by whichever tab or device
 * wrote it last — and every chat view writes `null` when it closes. Leave a
 * phone on the home screen, or close a second tab's chat, and the account says
 * no chat is open while the PC in front of the user still shows one. The port
 * kept a single open chat and took that at its word.
 *
 * Each tab knows what it shows (`ctx.getActiveChat()`), so every message from
 * the panel now says, and the backend follows it.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const host = (chatId: string, id: string, idx: number, user: boolean, text: string): Record<string, unknown> => ({
  id, chat_id: chatId, index_in_chat: idx,
  is_user: user, role: user ? 'user' : 'assistant',
  name: user ? 'You' : 'Narrator',
  content: text, send_date: 0, swipe_id: 0, swipes: [text], swipe_dates: [0],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})
for (const id of ['chat-1', 'chat-2']) {
  state.messages.set(id, [
    host(id, `${id}-u`, 0, true, 'I fight the wolf.'),
    host(id, `${id}-a`, 1, false, 'The wolf bites deep. You take 14 damage.'),
  ] as never)
}
state.generationResponse = '[CHARACTER]\nName: Kestrel\nHP: 20/34\n[/CHARACTER]'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await wait(700)
const { chatMirror } = await import('../src/compat/chat-mirror')
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const lastResult = (): Record<string, any> | undefined =>
  state.toFrontend.filter(m => (m as any).type === 'panel:result').at(-1) as any
const toasts = (): string[] => state.toFrontend
  .filter(m => (m as any).type === 'toast').map(m => String((m as any).message))

await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
for (let i = 0; i < 200 && chatMirror.getChatId() !== 'chat-1'; i++) await wait(5)
await wait(400)
settings.currentMemo = '[CHARACTER]\nName: Kestrel\nHP: 34/34\n[/CHARACTER]'
settings.stateTrackerRunEvery = 1

console.log('── another device leaves its chat ──')
// The phone goes to the home screen: the account's active chat becomes null.
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: null })
await wait(500)
state.toFrontend.length = 0
// The PC still shows chat-1, and the user presses Update state there.
await emitFrontendMessage(state, { type: 'tracker:run', viewChatId: 'chat-1' })
await wait(900)
check('Update state still finds the chat on the screen', chatMirror.getChatId() === 'chat-1',
  String(chatMirror.getChatId()))
check('and runs against it', !/chatId: none/.test(String(lastResult()?.reason ?? '')) && lastResult()?.changed === true,
  JSON.stringify(lastResult() ?? {}).slice(0, 120))

console.log('\n── a tab showing no chat ──')
await emitFrontendMessage(state, { type: 'panel:refresh', viewChatId: null })
await emitFrontendMessage(state, { type: 'panel:refresh' })
await wait(300)
check('changes nothing', chatMirror.getChatId() === 'chat-1', String(chatMirror.getChatId()))

console.log('\n── a reply finishes while the account says no chat is open ──')
settings.currentMemo = '[CHARACTER]\nName: Kestrel\nHP: 34/34\n[/CHARACTER]'
await state.interceptors[0].handler(
  [{ role: 'user', content: 'I fight the wolf.' }] as never,
  { chatId: 'chat-1', userId: state.userId, generationType: 'normal' } as never,
)
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: null })
await wait(400)
state.toFrontend.length = 0
await emitHostEvent(state, 'GENERATION_STARTED', { chatId: 'chat-1', generationType: 'normal' })
await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-1', messageId: 'chat-1-a', generationType: 'normal' })
await wait(900)
check('is tracked at once', /HP: 20\/34/.test(String(settings.currentMemo)), String(settings.currentMemo).match(/HP: [^\n]*/)?.[0])
check('not postponed with a toast telling the user to go back to the chat they are in',
  !toasts().some(t => /reply finished in/i.test(t)), toasts().join(' | '))

console.log('\n── a reply in a chat the user really did leave ──')
await emitFrontendMessage(state, { type: 'panel:refresh', viewChatId: 'chat-2' })
await wait(500)
check('the panel follows its tab into the other chat', chatMirror.getChatId() === 'chat-2', String(chatMirror.getChatId()))
state.toFrontend.length = 0
await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-1', messageId: 'chat-1-a', generationType: 'normal' })
await wait(600)
check('is still postponed, as before', toasts().some(t => /reply finished in/i.test(t))
  && chatMirror.getChatId() === 'chat-2')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'view chat test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
