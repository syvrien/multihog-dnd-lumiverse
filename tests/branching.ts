/**
 * branching.ts — carrying a campaign into a forked chat, and copying a world.
 *
 *   bun tests/branching.ts
 *
 * A campaign is the chat *plus* its tracker state, its stack of lorebooks, and
 * relationship values keyed by `Book::UID`. Fork the chat and leave that behind
 * and the branch opens with no character, no lore, and every NPC at zero.
 *
 * The remapping is the part that fails quietly: clone the books under new names
 * without following the keys and the branch looks fine until you notice nobody
 * remembers you.
 *
 * Upstream owns the fork gesture. Lumiverse gives an extension no way to fork a
 * chat but *tells* it when the user does, so the trigger here is `CHAT_FORKED`
 * — which also means it covers forks made through the host's own UI.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const msg = (id: string, chat: string, text: string): Record<string, unknown> => ({
  id, chat_id: chat, index_in_chat: 0, is_user: true, role: 'user', name: 'You',
  content: text, send_date: 0, swipe_id: 0, swipes: [text], swipe_dates: [0],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})
state.messages.set('chat-1', [msg('m1', 'chat-1', 'We hold the gate.')])
state.messages.set('chat-2', [msg('m2', 'chat-2', 'We hold the gate.')])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

// A campaign worth carrying: state, books, and relationships keyed by book.
const { saveWorldInfo } = await import('../src/compat/world-info')
await saveWorldInfo('chat_1_NPCs', {
  entries: { 0: { uid: 0, comment: 'Bram', key: ['bram'], content: 'An innkeeper.' } },
} as never)
await saveWorldInfo('chat_1_Locations', {
  entries: { 0: { uid: 0, comment: 'Khelt', key: ['khelt'], content: 'A walled town.' } },
} as never)
// Not this campaign's — it must not be dragged along.
await saveWorldInfo('Someone Elses Book', {
  entries: { 0: { uid: 0, comment: 'Nope', key: [], content: 'Unrelated.' } },
} as never)

settings.chatLinkEnabled = true
settings.chatStates = {
  'chat-1': {
    currentMemo: '[CHARACTER]\nSyg (Resonator)\nHP: 8/8\n[/CHARACTER]',
    routerCampaignPrefix: 'chat_1',
    activeRouterKeys: ['chat_1_NPCs::0'],
    npcRelationshipValues: { 'chat_1_NPCs::0': { friendship: 60, affection: 10 } },
  },
}

const { carryCampaignToFork, cloneCampaign } = await import('../src/tracker/branching')

console.log('── refusals ──')
check('a fork of nothing is not carried',
  !(await carryCampaignToFork('chat-unknown', 'chat-9')).ok,
  (await carryCampaignToFork('chat-unknown', 'chat-9')).reason ?? '')
check('a chat cannot fork from itself',
  !(await carryCampaignToFork('chat-1', 'chat-1')).ok)

console.log('\n── carrying a campaign into a fork ──')
const carried = await carryCampaignToFork('chat-1', 'chat-2')
check('carried', carried.ok, carried.reason ?? '')
check('no problems along the way', carried.errors.length === 0, carried.errors.join('; '))
check('copied the campaign lorebooks', carried.cloned === 2, String(carried.cloned))

const books = [...state.books.values()].map(book => book.name)
check('the branch has its own books',
  books.includes('chat_2_NPCs') && books.includes('chat_2_Locations'),
  books.join(', '))
check('the originals are untouched',
  books.includes('chat_1_NPCs') && books.includes('chat_1_Locations'))
check('unrelated books were left alone',
  books.filter(name => /Someone Elses/.test(name)).length === 1,
  'only this campaign travels')

const branch = settings.chatStates['chat-2']
check('the branch has the character sheet',
  String(branch?.currentMemo).includes('Syg'),
  String(branch?.currentMemo).slice(0, 30).replace(/\n/g, ' '))
check('and its own campaign prefix', branch?.routerCampaignPrefix === 'chat_2',
  String(branch?.routerCampaignPrefix))

// The quiet failure this whole slice exists to prevent.
check('active keys follow the renamed books',
  branch?.activeRouterKeys?.includes('chat_2_NPCs::0'),
  (branch?.activeRouterKeys ?? []).join(', '))
check('and so do the relationships',
  branch?.npcRelationshipValues?.['chat_2_NPCs::0']?.friendship === 60,
  JSON.stringify(branch?.npcRelationshipValues))
check('the original campaign is unchanged',
  settings.chatStates['chat-1'].npcRelationshipValues['chat_1_NPCs::0'].friendship === 60)

console.log('\n── carrying twice ──')
// CHAT_FORKED and the chat switch after it can both land.
const again = await carryCampaignToFork('chat-1', 'chat-2')
check('a second carry is refused', !again.ok, again.reason ?? '')
check('and did not duplicate the books',
  [...state.books.values()].filter(book => book.name === 'chat_2_NPCs').length === 1,
  'copying twice would leave a second stack behind')

console.log('\n── the host event drives it ──')
state.messages.set('chat-3', [msg('m3', 'chat-3', 'We hold the gate.')])
state.toFrontend.length = 0
await emitHostEvent(state, 'CHAT_FORKED', {
  sourceChatId: 'chat-1', forkedChatId: 'chat-3',
  chat: { id: 'chat-3' }, branchId: 'b1',
  forkedAtMessageId: 'm1', forkedAtMessageIndex: 0,
})
await wait(700)
check('forking in the host carries the campaign',
  !!settings.chatStates['chat-3']?.currentMemo,
  'this is the path a real fork takes')
check('and says so', state.toFrontend.some(m =>
  (m as any).type === 'toast' && /carried/i.test(String((m as any).message))))

console.log('\n── copying a world ──')
const copied = await cloneCampaign('sequel')
check('copied the books', copied.ok && copied.cloned === 2,
  copied.reason ?? String(copied.cloned))
const after = [...state.books.values()].map(book => book.name)
check('under the new name',
  after.includes('sequel_NPCs') && after.includes('sequel_Locations'),
  after.filter(n => /sequel/.test(n)).join(', '))
// A new run in the same world, not the same campaign twice.
check('but not the character or progress',
  !settings.chatStates.sequel,
  'copying a world must not copy the playthrough')

check('an empty name is refused', !(await cloneCampaign('   ')).ok)
check('copying onto itself is refused', !(await cloneCampaign('chat_1')).ok,
  (await cloneCampaign('chat_1')).reason ?? '')

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'campaign:clone', prefix: 'third-run' })
await wait(600)
const result = state.toFrontend.find(m => (m as any).type === 'campaign:cloned') as any
check('the panel is told the outcome', result?.ok === true && result.cloned === 2,
  JSON.stringify({ ok: result?.ok, cloned: result?.cloned }))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 110)}`)
check('no errors', errors.length === 0, errors[0]?.message?.slice(0, 80) ?? '')

console.log(`\n${failures === 0 ? 'branching test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
