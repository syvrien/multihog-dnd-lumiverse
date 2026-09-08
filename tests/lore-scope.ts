/**
 * lore-scope.ts — which lorebooks the State Tracker gets to read.
 *
 *   bun tests/lore-scope.ts
 *
 * `buildLorebookContext()` is what puts world lore in front of the tracker, and
 * it was returning an empty string in every configuration:
 *
 *   - `ctxWorldInfo` defaults to `false` and the port never exposed it, so the
 *     feature could not be switched on at all;
 *   - and with it on, the "every book" branch calls
 *     `stCtx.getWorldInfoNames?.()` **synchronously** against a function this
 *     port made `async`. A Promise has no `.length`, so it fell through a retry,
 *     then a REST fetch the shim rejects, then tried to iterate the Promise —
 *     into a `catch` that only warns.
 *
 * Making that function synchronous to suit the call site looked right and broke
 * the map manifest, which depends on its lazy rebuild. So the filter is filled
 * in on the port side instead, where the call can be awaited — and the card
 * names its own books, which is a better scope than "all" ever was.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'x', send_date: 0, swipe_id: 0, swipes: ['x'],
  swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
}])

// Two books: one the card brings, one from an unrelated campaign.
const book = (id: string, name: string): void => {
  state.books.set(id, {
    id, name, description: '', metadata: {}, created_at: 0, updated_at: 0,
  })
}
const entry = (id: string, bookId: string, content: string): void => {
  state.entries.set(id, {
    id, world_book_id: bookId, key: ['k'], keysecondary: [], comment: id,
    content, constant: false, selective: false, disabled: false,
    order_value: 0, position: 0, probability: 100, depth: 0,
  })
}
book('book-khelt', 'Khelt Lore')
entry('e-khelt', 'book-khelt', 'The ferryman will not cross the third bridge.')
book('book-other', 'Someone Elses Campaign')
entry('e-other', 'book-other', 'A dragon called Muriel rules the eastern reach.')

state.characterCards.set('card-1', {
  id: 'card-1', name: 'Khelt', description: 'A drowned city.',
  scenario: '', first_mes: '', personality: '',
  world_book_ids: ['book-khelt'],
})
state.chatCharacter.set('chat-1', 'card-1')

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
const memo = await import('../src/engine/memo-processor.js') as {
  buildLorebookContext: () => Promise<string>
}

console.log('── off by default ──')
check('the tracker gets no lore until asked', settings.ctxWorldInfo === false)
check('and the context is empty', (await memo.buildLorebookContext()).length === 0)

console.log('\n── the card names its own books ──')
settings.ctxWorldInfo = true
const scoped = await memo.buildLorebookContext()
check('lore now reaches the tracker', scoped.length > 0, `${scoped.length} chars`)
check('the card’s book is in it', /third bridge/.test(scoped),
  'this was empty in every configuration before now')
// The whole point of scoping: another campaign's dragon is not this campaign's.
check('another campaign’s book is not', !/Muriel/.test(scoped),
  'upstream read every book because SillyTavern could not tell them apart')
check('the filter names the book, not nothing',
  (settings.lorebookFilter ?? []).join() === 'Khelt Lore',
  JSON.stringify(settings.lorebookFilter))

console.log('\n── every book, when asked for ──')
await emitFrontendMessage(state, {
  type: 'settings:patch', patch: { loreScope: 'all' },
})
await wait()
const all = await memo.buildLorebookContext()
check('both books are in it', /third bridge/.test(all) && /Muriel/.test(all),
  `${all.length} chars`)
// The filter is named rather than left empty on purpose: an empty filter sends
// `buildLorebookContext` down the branch that calls an async function
// synchronously and silently yields nothing.
check('the filter is filled in rather than left empty',
  (settings.lorebookFilter ?? []).length === 2,
  JSON.stringify(settings.lorebookFilter))

console.log('\n── a hand-curated filter is left alone ──')
settings.lorebookFilter = ['Khelt Lore']
await emitFrontendMessage(state, {
  type: 'settings:patch', patch: { loreScope: 'manual' },
})
await wait()
check('the filter survives a chat switch',
  (settings.lorebookFilter ?? []).join() === 'Khelt Lore',
  JSON.stringify(settings.lorebookFilter))
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await wait()
check('and stays put afterwards',
  (settings.lorebookFilter ?? []).join() === 'Khelt Lore',
  JSON.stringify(settings.lorebookFilter))

console.log('\n── a card with no books means none, not all ──')
state.characterCards.set('card-1', {
  id: 'card-1', name: 'Khelt', description: 'A drowned city.',
  scenario: '', first_mes: '', personality: '', world_book_ids: [],
})
await emitFrontendMessage(state, {
  type: 'settings:patch', patch: { loreScope: 'card' },
})
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await wait()
const none = await memo.buildLorebookContext()
check('no lore is sent', none.length === 0, `${none.length} chars`)
// An empty filter would mean "every book", which is the opposite of what
// "the card's own" asked for.
check('and it did not silently widen to everything',
  !/Muriel/.test(none), JSON.stringify(settings.lorebookFilter))

console.log('\n── the map manifest still works ──')
// `getWorldInfoNames()` stays async because its lazy rebuild is what catches
// books created outside `saveWorldInfo`. Making it synchronous for the call
// site above emptied this instead — so it is checked here too.
const { listMaps } = await import('../src/tracker/map-view')
const maps = await listMaps()
check('the manifest resolves without throwing', maps.ok, maps.reason ?? '')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const item of errors) console.log(`  ${item.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'lore scope test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
