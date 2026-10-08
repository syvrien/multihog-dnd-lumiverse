/**
 * npc-library.ts — the shelf of NPCs kept between campaigns, and the memo backup.
 *
 *   bun tests/npc-library.ts
 *
 * Both were ported as logic with no way to reach them. The library's whole
 * point is moving a character *between* games, so the checks that matter are
 * about what survives the trip and what must not: a card lifted out of one
 * campaign should not arrive in the next already resenting a player it has
 * never met.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'We talk to Bram.', send_date: 0, swipe_id: 0,
  swipes: ['We talk to Bram.'], swipe_dates: [0], extra: {},
  parent_message_id: null, branch_id: null, created_at: 0,
}])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 350): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

const {
  captureFromCampaign, deleteCard, exportCard, importCards, listLibrary, saveCard, useCard,
} = await import('../src/tracker/npc-library')

console.log('── empty to begin with ──')
check('no cards yet', (await listLibrary()).length === 0)

console.log('\n── keeping someone from the campaign ──')
// Relationship lines are campaign-specific and must not travel.
settings.currentMemo = `[NPC]
Bram — An innkeeper in Khelt, greying, keeps a ledger of debts.
Friendship/Rapport: 60/150
Affection/Interest: 10/150

Alia — A courier with a limp and a fast horse.
[/NPC]`

check('refuses a name that is not there',
  !(await captureFromCampaign('Nobody')).ok,
  (await captureFromCampaign('Nobody')).reason ?? '')

const kept = await captureFromCampaign('Bram')
check('kept them', kept.ok, kept.reason ?? '')

let cards = await listLibrary()
check('the card is on the shelf', cards.length === 1, String(cards.length))
check('it carries who they are', /innkeeper in Khelt/.test(cards[0].content),
  cards[0].content.slice(0, 40))
check('but not this campaign\'s relationship with them',
  !/Friendship/.test(cards[0].content),
  'a card must not arrive in the next game already resenting someone')

console.log('\n── names stay distinct ──')
await captureFromCampaign('Bram')
cards = await listLibrary()
check('a second capture does not silently replace the first',
  cards.length === 2 && cards[0].name !== cards[1].name,
  cards.map(c => c.name).join(', '))

console.log('\n── editing ──')
const target = cards[0]
await saveCard({
  id: target.id, name: target.name,
  content: `${target.content}\nCarries a short iron bar behind the bar.`,
  notes: 'From the Driftstone game.',
})
const edited = (await listLibrary()).find(card => card.id === target.id)
check('the edit stuck', /iron bar/.test(edited?.content ?? ''))
check('and the private note with it', edited?.notes === 'From the Driftstone game.')
check('a nameless card is refused', !(await saveCard({
  name: '  ', content: 'x', notes: '',
})).ok)

console.log('\n── sharing ──')
const exported = await exportCard(target.id)
check('exported', exported.ok && (exported.text ?? '').length > 0,
  exported.reason ?? `${(exported.text ?? '').length} chars`)
check('exporting something gone is refused', !(await exportCard('nope')).ok)

const before = (await listLibrary()).length
const imported = await importCards(exported.text ?? '')
check('imported it back', imported.ok && imported.added === 1,
  imported.reason ?? String(imported.added))
check('as a new card rather than overwriting',
  (await listLibrary()).length === before + 1,
  'an import must never silently replace a card you have')
check('nonsense is refused', !(await importCards('not a card')).ok)

console.log('\n── bringing one into the game ──')
state.generationResponse = `[PARTY]
Bram — An innkeeper, now travelling with the party.
[/PARTY]`
const used = await useCard(target.id, 'party')
check('added to the party', used.ok, used.reason ?? '')
check('through the tracker, not by hand-editing the memo',
  /Bram/.test(String(settings.currentMemo)) && state.generations.length > 0,
  `${state.generations.length} generation(s)`)

const prompt = (state.generations[state.generations.length - 1] as {
  messages?: Array<{ content: string }>
})?.messages?.map(m => m.content).join('\n') ?? ''
check('the card reached the prompt', /innkeeper/i.test(prompt))

console.log('\n── deleting ──')
await deleteCard(target.id)
check('gone', !(await listLibrary()).some(card => card.id === target.id))
check('deleting something gone is refused', !(await deleteCard(target.id)).ok)

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'npc:read' })
await wait()
const pushed = state.toFrontend.find(m => (m as any).type === 'npc:library') as any
check('the panel is sent the shelf', Array.isArray(pushed?.cards),
  `${pushed?.cards?.length ?? 0} card(s)`)

console.log('\n── the memo backup ──')
// Every commit above already took one; this is the copy that survives a
// settings tree coming back short.
const { snapshotMemo } = await import('../src/tracker/recovery')
const readBackup = (): string => {
  const key = [...state.userStorage.keys()].find(entry => /local-storage/.test(entry))
  return key ? String(state.userStorage.get(key)) : ''
}
await wait(1200)
check('a backup exists for this chat', /chat-1/.test(readBackup()),
  readBackup() ? 'written to per-user storage' : '(none)')
check('and it holds what was committed', /Bram/.test(readBackup()),
  'the party addition was the last commit')

// The engine refuses to replace a backup with a shorter one — which is the
// whole point, since the case it guards against *is* a memo that came back
// short. Losing the good copy to the bad one would defeat it entirely.
settings.currentMemo = '[CHARACTER]\nSyg\n[/CHARACTER]'
await snapshotMemo('chat-1')
await wait(1200)
check('a shorter memo does not overwrite it', /Bram/.test(readBackup()),
  'refusing to shrink is what makes the backup worth having')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 110)}`)

console.log(`\n${failures === 0 ? 'npc library test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
