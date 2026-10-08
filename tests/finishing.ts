/**
 * finishing.ts — the last three known gaps.
 *
 *   bun tests/finishing.ts
 *
 * Each of these was a silent wrong answer rather than a missing feature, which
 * is the failure mode this port keeps producing:
 *
 *   - framework notes injected at depth arrived labelled `assistant`, so the
 *     model was shown its own supposed output and asked to continue from it;
 *   - a Display Group's member order was whatever sequence you happened to
 *     assign in, while the renderer treats that order as deliberate;
 *   - the REST shim's book list took one page of 200 and the Lorebook Agent
 *     never saw anything past it.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'I open the door.', send_date: 0, swipe_id: 0,
  swipes: ['I open the door.'], swipe_dates: [0], extra: {},
  parent_message_id: null, branch_id: null, created_at: 0,
}])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
settings.enabled = true

console.log('── framework notes are not narrator turns ──')
/*
 * The engine splices its depth injections in as `{ is_user: false,
 * extra: { type: 'narrator' } }`, and that marker is the whole signal. The
 * mapping is a named function so it can be checked against each of the three
 * shapes upstream produces, rather than by reconstructing the conditions under
 * which the engine decides to inject.
 */
const { roleForStMessage } = await import('../src/compat/chat-mirror')

// roleVal 0 — the default for lore, and always for Dungeon Reality.
check('a narrator-marked note is a system message',
  roleForStMessage({
    name: 'Dungeon Reality', mes: 'The crypt floods at high tide.',
    is_user: false, extra: { type: 'narrator' },
  }) === 'system',
  'this was arriving as `assistant`: the model shown its own supposed output')

// roleVal 1 — the user-role option.
check('the user-role option is still a user turn',
  roleForStMessage({ mes: 'x', is_user: true, extra: {} }) === 'user')

// roleVal 2 — the assistant-role option, and it is deliberate.
check('an unmarked non-user message stays assistant',
  roleForStMessage({ mes: 'x', is_user: false, extra: {} }) === 'assistant',
  'roleVal 2 exists and must keep working')

check('an explicitly system message stays system',
  roleForStMessage({ mes: 'x', is_user: false, is_system: true, extra: {} }) === 'system')
check('a message with no extra at all is safe',
  roleForStMessage({ mes: 'x', is_user: false }) === 'assistant')

console.log('\n── and through the real interceptor ──')
const handler = state.interceptors[0]?.handler
check('an interceptor is registered', typeof handler === 'function')

const out = await handler(
  [{ role: 'user', content: 'I open the door.' }] as never,
  { chatId: 'chat-1', userId: 'user-1', generationType: 'normal' } as never,
) as Array<{ role: string; content: string; name?: string }>

check('the conversation survives the round trip',
  out.find(message => /I open the door/.test(message.content))?.role === 'user')
// The narrator ruleset is the port's own system injection; nothing should be
// carrying a speaker name on a system message.
check('no system message carries a speaker name',
  out.filter(message => message.role === 'system').every(message => !('name' in message)),
  'some providers reject `name` on system, and a framework note has no speaker')

console.log('\n── display group member order ──')
const groups = await import('../src/tracker/display-groups')
settings.displayGroups = []
settings.displayGroupsEnabled = true

const made = await groups.addDisplayGroup('Survival', 'INVENTORY')
const id = made.view!.groups[0].id
await groups.assignDisplayModule('ABILITIES', id)
await groups.assignDisplayModule('SPELLS', id)

const start = (await groups.readDisplayGroups()).groups[0].members
check('assigning appends, so the order is the order you added in',
  start.join() === 'INVENTORY,ABILITIES,SPELLS', start.join())

const movedUp = await groups.moveDisplayMember(id, 'SPELLS', 'up')
check('a member moves up', movedUp.view?.groups[0].members.join() === 'INVENTORY,SPELLS,ABILITIES',
  String(movedUp.view?.groups[0].members))

const movedDown = await groups.moveDisplayMember(id, 'INVENTORY', 'down')
check('and down', movedDown.view?.groups[0].members.join() === 'SPELLS,INVENTORY,ABILITIES',
  String(movedDown.view?.groups[0].members))

// The buttons are disabled at the ends; a no-op there should not be an error.
const atTop = await groups.moveDisplayMember(id, 'SPELLS', 'up')
check('moving past the top is a quiet no-op', atTop.ok
  && atTop.view?.groups[0].members.join() === 'SPELLS,INVENTORY,ABILITIES')
const atEnd = await groups.moveDisplayMember(id, 'ABILITIES', 'down')
check('and past the bottom', atEnd.ok
  && atEnd.view?.groups[0].members.join() === 'SPELLS,INVENTORY,ABILITIES')

check('moving a module that is not in the group is refused',
  !(await groups.moveDisplayMember(id, 'TIME', 'up')).ok)
check('moving in a group that is gone is refused',
  !(await groups.moveDisplayMember('nope', 'SPELLS', 'up')).ok)

console.log('\n── and the renderer lays them out in that order ──')
// The point of all of it: the engine documents this order as user-configurable
// and uses it for the cards inside the folded group.
const engineGroups = await import('../src/engine/src/features/display-groups.js') as any
const plan = engineGroups.buildDisplayGroupRenderPlan(
  ['INVENTORY', 'ABILITIES', 'SPELLS'],
  (await groups.readDisplayGroups()).groups,
  true,
)
const folded = plan.find((item: any) => item.kind === 'group')
check('the group renders as one card', !!folded, JSON.stringify(plan).slice(0, 80))
check('with the members in the order the editor set',
  folded?.tags?.join() === 'SPELLS,INVENTORY,ABILITIES',
  String(folded?.tags))

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, {
  type: 'groups:move', id, tag: 'ABILITIES', direction: 'up',
})
await wait()
const pushed = state.toFrontend.find(m => (m as any).type === 'groups:state') as any
check('reordering reaches the editor',
  pushed?.groups?.[0]?.members?.join() === 'SPELLS,ABILITIES,INVENTORY',
  String(pushed?.groups?.[0]?.members))
check('and the panel is repainted',
  state.toFrontend.some(m => (m as any).type === 'panel:render'),
  'the order is what the panel draws')

console.log('\n── the book list is paged ──')
// The Lorebook Agent discovers books through the REST shim. One page of 200
// meant a long campaign simply lost the rest, with no error anywhere.
for (let n = 0; n < 260; n++) {
  state.books.set(`book-${n}`, {
    id: `book-${n}`, name: `Campaign_Book_${String(n).padStart(3, '0')}`,
    description: '', metadata: {}, created_at: 0, updated_at: 0,
  })
}
const { invalidateWorldInfoCache } = await import('../src/compat/world-info')
invalidateWorldInfoCache()

const listed = await fetch('/api/worldinfo/list', {
  method: 'POST', body: JSON.stringify({}),
})
const books = await listed.json() as Array<{ file_id: string }>
check('every book is listed, not the first page', books.length >= 260,
  `${books.length} of ${state.books.size}`)
check('including one past the page boundary',
  books.some(book => book.file_id === 'Campaign_Book_259'),
  'this is the one that used to vanish')

// Deleting resolved the name through the same truncated call.
const deleted = await fetch('/api/worldinfo/delete', {
  method: 'POST', body: JSON.stringify({ name: 'Campaign_Book_259' }),
})
check('and a book past the boundary can be deleted', deleted.ok,
  `${deleted.status} — "not found" for a book that exists is a silent no-op`)
check('it really went', !state.books.has('book-259'))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'finishing test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
