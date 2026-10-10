/**
 * records-view.ts — the Records tab shows what the Lorebook Agent filed.
 *
 *   bun tests/records-view.ts
 *
 * Reported: on a second device, Records said "Nothing recorded yet" although
 * the chat had NPCs in it. Three things could produce that, and all three did:
 *
 *   - the backend answered for whatever chat it last heard of, not the one on
 *     that device's screen — and a stray "no chat" from another device left it
 *     with none, so the campaign's prefix was empty and so was the list
 *   - an open Records tab was never refreshed: it read once when built and on
 *     being reopened, so what the agent filed after that stayed invisible
 *   - the agent files every few replies (3 by default), and the empty message
 *     did not say so — a short session reads as "broken", not "not yet"
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
    host(id, `${id}-u`, 0, true, 'I walk into the inn.'),
    host(id, `${id}-a`, 1, false, 'Bram the innkeeper waves you over.'),
  ] as never)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await wait(700)
const { chatMirror } = await import('../src/compat/chat-mirror')
const go = async (id: string | null): Promise<void> => {
  await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: id })
  for (let i = 0; i < 200 && chatMirror.getChatId() !== id; i++) await wait(5)
  await wait(400)
}
const { saveWorldInfo } = await import('../src/compat/world-info')
const people = (records: any): string[] =>
  (records?.groups ?? []).find((g: any) => g.id === 'npc')?.entries.map((e: any) => e.label) ?? []
const latestRecords = (): any => state.toFrontend.filter(m => (m as any).type === 'records:state').at(-1)
const read = async (viewChatId: string | null): Promise<any> => {
  state.toFrontend.length = 0
  await emitFrontendMessage(state, { type: 'records:read', viewChatId })
  await wait(300)
  return latestRecords()
}

await go('chat-1')
// What the agent filed for each campaign.
await saveWorldInfo('chat_1_NPCs', {
  entries: { 0: { uid: 0, comment: 'Bram', key: ['bram'], content: 'Innkeeper of the Ash & Ale.' } },
} as never)
await saveWorldInfo('chat_2_NPCs', {
  entries: { 0: { uid: 0, comment: 'Zed', key: ['zed'], content: 'A smuggler.' } },
} as never)

console.log('── on another device ──')
// The other device left its chat: the account now says no chat is open.
await go(null)
const records = await read('chat-1')
check('Records shows what was filed for the chat on this screen', people(records).includes('Bram'),
  JSON.stringify(people(records)))

console.log('\n── while the other device is in a different chat ──')
await go('chat-2')
const mine = await read('chat-1')
check('shows this chat\'s campaign, not the other device\'s', people(mine).includes('Bram') && !people(mine).includes('Zed'),
  JSON.stringify(people(mine)))

console.log('\n── after the agent files something ──')
await read('chat-1')
// The agent writes during the turn's post-generation passes.
await saveWorldInfo('chat_1_NPCs', {
  entries: {
    0: { uid: 0, comment: 'Bram', key: ['bram'], content: 'Innkeeper of the Ash & Ale.' },
    1: { uid: 1, comment: 'Mira', key: ['mira'], content: 'A bard with a borrowed lute.' },
  },
} as never)
state.toFrontend.length = 0
await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-1', messageId: 'chat-1-a', generationType: 'normal' })
await wait(900)
check('an open Records tab is sent the new entry without being reopened', people(latestRecords()).includes('Mira'),
  JSON.stringify(people(latestRecords())))

console.log('\n── before the agent has filed anything ──')
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
settings.routerRunEvery = 3
const fresh = await read('chat-2')
check('Records says when the agent will next file', fresh?.agent?.enabled === true && fresh?.agent?.runEvery === 3
  && typeof fresh?.agent?.repliesUntilNext === 'number', JSON.stringify(fresh?.agent))
settings.routerEnabled = false
const off = await read('chat-2')
check('and says so when the agent is off', off?.agent?.enabled === false, JSON.stringify(off?.agent))
settings.routerEnabled = true

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'records view test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
