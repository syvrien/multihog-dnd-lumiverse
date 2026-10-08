/**
 * chat-cleanup.ts — what a deleted chat leaves behind.
 *
 *   bun tests/chat-cleanup.ts
 *
 * Lumiverse emits CHAT_DELETED and the port ignored it: the deleted chat's
 * saved campaign stayed in the settings blob, rewritten on every save, and its
 * lorebooks stayed in the account. Upstream cleans both up (2026.9); this
 * checks the port does, and — at least as important — that it removes nothing
 * it should not: a chat that still exists, a book another campaign uses, a book
 * a character card depends on, or anything at all when it cannot see the
 * user's whole chat list.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const msg = (chatId: string): never => ([{
  id: 'm-' + chatId, chat_id: chatId, index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'x', send_date: 0, swipe_id: 0, swipes: ['x'],
  swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
}] as never)
for (const id of ['chat-lobby', 'chat-keep', 'chat-gone', 'chat-old', 'chat-open', 'chat-open-2', 'chat-c']) state.messages.set(id, msg(id))

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
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const { saveWorldInfo } = await import('../src/compat/world-info')
const book = async (name: string): Promise<void> => {
  await saveWorldInfo(name, { entries: { 0: { uid: 0, comment: name, key: ['k'], content: name } } } as never)
}
const bookNames = (): string[] => [...state.books.values()].map((b: any) => b.name).sort()

// Answer the next popup, returning what it asked.
const answer = async (result: unknown): Promise<string> => {
  for (let i = 0; i < 150; i++) {
    const open = state.toFrontend.find(m => (m as any).type === 'popup:open') as any
    if (open) {
      state.toFrontend.splice(state.toFrontend.indexOf(open), 1)
      await emitFrontendMessage(state, { type: 'popup:result', requestId: open.requestId, result })
      return String(open.content)
    }
    await wait(10)
  }
  return ''
}

// Three campaigns with their lorebooks, recorded as upstream records them —
// seeded from a chat that is none of them, since the open chat's live state is
// what gets saved for it.
await go('chat-lobby')
await book('chat_keep_NPCs')
await book('chat_gone_NPCs')
await book('chat_gone_Locations')
await book('chat_gone_Shared')
await book('chat_old_NPCs')
settings.chatStates = {
  'chat-keep': { currentMemo: 'keep', campaignBooks: ['chat_keep_NPCs', 'chat_gone_Shared'] },
  'chat-gone': { currentMemo: 'gone', campaignBooks: ['chat_gone_NPCs', 'chat_gone_Locations', 'chat_gone_Shared'] },
  'chat-old': { currentMemo: 'old', campaignBooks: ['chat_old_NPCs'] },
}
// A character card depends on one of the deleted chat's books.
const { findWorldBook } = await import('../src/compat/world-info')
const locations = await findWorldBook('chat_gone_Locations')
state.characterCards.set('card-1', {
  id: 'card-1', name: 'Khelt', description: '', scenario: '', first_mes: '', personality: '',
  world_book_ids: [locations!.id],
})

console.log('── a deletion event for a chat that still exists ──')
state.toFrontend.length = 0
await emitHostEvent(state, 'CHAT_DELETED', { id: 'chat-gone' })
await wait(500)
check('removes nothing — the host still has it', !!settings.chatStates['chat-gone'],
  'verify before removing, as upstream does')
check('and offers to delete none of its lorebooks', !state.toFrontend.some(m => (m as any).type === 'popup:open'))

console.log('\n── deleting a chat ──')
state.deletedChats.add('chat-gone')
state.messages.delete('chat-gone')
state.toFrontend.length = 0
void emitHostEvent(state, 'CHAT_DELETED', { id: 'chat-gone' })
const offered = await answer(1) // AFFIRMATIVE — delete the lorebooks
await wait(600)
check('its saved campaign is removed', !settings.chatStates['chat-gone'])
check('the other campaigns are untouched',
  settings.chatStates['chat-keep']?.currentMemo === 'keep' && settings.chatStates['chat-old']?.currentMemo === 'old')
check('it asked before deleting any lorebook', offered.length > 0, offered.slice(0, 60))
check('offering only the deleted chat’s own book', /chat_gone_NPCs/.test(offered)
  && !/chat_gone_Shared/.test(offered) && !/chat_gone_Locations/.test(offered), offered.replace(/<[^>]+>/g, ' ').slice(0, 140))
check('which is gone', !bookNames().includes('chat_gone_NPCs'), bookNames().join(', '))
check('a book another campaign also records is kept', bookNames().includes('chat_gone_Shared'))
check('and so is one a character card depends on', bookNames().includes('chat_gone_Locations'))

console.log('\n── declining the lorebook question ──')
await book('chat_old_Locations')
settings.chatStates['chat-old'].campaignBooks.push('chat_old_Locations')
state.deletedChats.add('chat-old')
state.messages.delete('chat-old')
void emitHostEvent(state, 'CHAT_DELETED', { id: 'chat-old' })
await answer(0) // NEGATIVE — keep lorebooks
await wait(600)
check('keeps the lorebooks', bookNames().includes('chat_old_NPCs') && bookNames().includes('chat_old_Locations'))
check('but still removes the saved campaign', !settings.chatStates['chat-old'])

console.log('\n── deleting the chat that is open ──')
await go('chat-open')
const { writeMemo } = await import('../src/tracker/direct-prompt')
await writeMemo('[CHARACTER]\nSyg (Resonator)\nHP: 8/8\n[/CHARACTER]')
check('it has a saved campaign to lose', !!settings.chatStates['chat-open'])
state.deletedChats.add('chat-open')
state.messages.delete('chat-open')
await emitHostEvent(state, 'CHAT_DELETED', { id: 'chat-open' })
await wait(600)
// The host moves the user somewhere else; the switch away from a deleted chat
// must not save it on the way out and bring its campaign back.
await go('chat-keep')
await wait(300)
check('switching away does not bring it back', !settings.chatStates['chat-open'])

console.log('\n── the host switches away and deletes in the same moment ──')
await go('chat-open-2')
await writeMemo('[CHARACTER]\nSyg (Resonator)\nHP: 8/8\n[/CHARACTER]')
check('it has a saved campaign to lose', !!settings.chatStates['chat-open-2'])
state.deletedChats.add('chat-open-2')
state.messages.delete('chat-open-2')
// The host's switch is asked for first and is still running when the delete lands.
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-keep' })
void emitHostEvent(state, 'CHAT_DELETED', { id: 'chat-open-2' })
await wait(900)
check('the tracker follows the user, not the deleted chat', chatMirror.getChatId() === 'chat-keep',
  String(chatMirror.getChatId()))
check('and the deleted chat stays gone', !settings.chatStates['chat-open-2'])

console.log('\n── switches land in the order they were made ──')
void emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-c' })
// The host's switch is asked for first and is still running when the delete lands.
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-keep' })
await wait(900)
check('two quick switches end where the user did', chatMirror.getChatId() === 'chat-keep',
  String(chatMirror.getChatId()))
check('with that chat’s campaign loaded', settings.currentMemo === 'keep', String(settings.currentMemo).slice(0, 40))

console.log('\n── catching up on chats deleted before any of this ──')
settings.chatStates['chat-ancient'] = { currentMemo: 'ancient', campaignBooks: [] }
settings.chatStates['chat-ancient-2'] = { currentMemo: 'ancient 2', campaignBooks: [] }
state.toFrontend.length = 0
void emitFrontendMessage(state, { type: 'settings:action', action: 'cleanDeletedChats' })
const asked = await answer(1)
await wait(600)
check('it asks first, naming how many', /2 chat/.test(asked), asked.replace(/<[^>]+>/g, ' ').slice(0, 80))
check('and removes their saved data',
  !settings.chatStates['chat-ancient'] && !settings.chatStates['chat-ancient-2'])
check('leaving every live chat alone', settings.chatStates['chat-keep']?.currentMemo === 'keep')

console.log('\n── refusing to judge from an incomplete chat list ──')
settings.chatStates['chat-ancient-3'] = { currentMemo: 'ancient 3', campaignBooks: [] }
const realList = (spindle as any).chats.list
;(spindle as any).chats.list = async (options: any) => {
  const page = await realList(options)
  return { ...page, total: page.total + 5 } // the host says there are more than were returned
}
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'settings:action', action: 'cleanDeletedChats' })
await wait(400)
;(spindle as any).chats.list = realList
check('nothing is removed', settings.chatStates['chat-ancient-3']?.currentMemo === 'ancient 3'
  && settings.chatStates['chat-keep']?.currentMemo === 'keep')
check('and it does not even ask', !state.toFrontend.some(m => (m as any).type === 'popup:open'))
check('saying why', /full chat list/.test(String((state.toFrontend.filter(m => (m as any).type === 'toast').at(-1) as any)?.message)))

console.log('\n── it is a button in the settings ──')
const { SETTINGS_SCHEMA } = await import('../src/shared/settings-schema')
check('offered as an action', SETTINGS_SCHEMA.some(area =>
  (area.fields ?? []).some(f => f.key === 'cleanDeletedChats' && f.kind === 'action')))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'chat cleanup test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
