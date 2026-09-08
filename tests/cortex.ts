/**
 * cortex.ts — handing tracked state to Lumiverse's own memory.
 *
 *   bun tests/cortex.ts
 *
 * Upstream requires a summarizer because SillyTavern has no memory. Lumiverse
 * has one, so the port's job is not to add a summarizer but to stop the two
 * systems duplicating: the Cortex infers a cast from prose, while the tracker
 * already knows one exactly.
 *
 * The checks that matter are about **not making things worse**:
 *
 *   - off by default, because this writes to host-level memory that outlives
 *     the extension;
 *   - upsert, not insert — syncing twice must not double the graph;
 *   - relations need both endpoints, and the API drops an edge silently when
 *     one is missing, so the ordering has to be right or nothing says so;
 *   - one bad name must not lose the rest of the campaign.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'x', send_date: 0, swipe_id: 0, swipes: ['x'],
  swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
}])

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

const cortex = await import('../src/tracker/cortex')

// A campaign with a party, a benched member, tracked standing and a mapped site.
settings.currentMemo = `[CHARACTER]
Syg (Resonator)
HP: 8/8
Level: 3
[/CHARACTER]

[PARTY]
Kestrel — a ranger with a bad knee.
Bram the Quiet — never explains the axe.
[/PARTY]

[BENCHED PARTY]
Vessa Corrin — left at the waystation.
[/BENCHED PARTY]`

settings.npcRelationshipBars = true
settings.npcRelationshipMax = 100
settings.npcRelationshipValues = {
  'Camp_npcs::Kestrel': { friendship: 70, affection: 10 },
  'Camp_npcs::Bram the Quiet': { friendship: -40, affection: 0 },
  'Camp_npcs::Illia': { friendship: 30, affection: 75 },
}
settings.mapEvolutionLastFiredBySite = { 'The Ash Door': 1 }

console.log('── what Multihog is authoritative about ──')
const candidates = await cortex.collectCandidates()
const named = (name: string) =>
  candidates.find(candidate => candidate.name.toLowerCase() === name.toLowerCase())

check('the player character is included', !!named('Syg'), candidates.map(c => c.name).join(', '))
check('so is the party', !!named('Kestrel') && !!named('Bram the Quiet'))
check('and a benched member', !!named('Vessa Corrin'))
check('a mapped site comes through as a location',
  named('The Ash Door')?.type === 'location', String(named('The Ash Door')?.type))

// The trap that filed a hit point total as a party member once before.
check('stat lines are not people',
  !candidates.some(candidate => /^(HP|Level)$/i.test(candidate.name)),
  candidates.map(c => c.name).join(', '))

console.log('\n── standing becomes a real edge ──')
check('a friend is an ally', named('Kestrel')?.relation === 'ally',
  String(named('Kestrel')?.relation))
check('negative standing is an enemy', named('Bram the Quiet')?.relation === 'enemy',
  String(named('Bram the Quiet')?.relation))
check('high affection outranks liking', named('Illia')?.relation === 'lover',
  String(named('Illia')?.relation))
check('and the sentiment is signed',
  (named('Bram the Quiet')?.sentiment ?? 0) < 0 && (named('Kestrel')?.sentiment ?? 0) > 0,
  `${named('Bram the Quiet')?.sentiment} / ${named('Kestrel')?.sentiment}`)
check('the tracked values ride along as valence',
  named('Kestrel')?.valence?.friendship === 0.7,
  JSON.stringify(named('Kestrel')?.valence))

console.log('\n── off by default ──')
// Writing into the user's account-level memory is not implied by installing a
// tracker, so the switch has to be theirs.
delete settings.cortexSyncEnabled
check('the sync is off until asked for', (await cortex.cortexAvailable()).enabled === false)
check('and the view says so', (await cortex.readCortex('user-1')).enabled === false)

await cortex.setCortexSync(true)
check('it can be switched on', (await cortex.cortexAvailable()).enabled === true)

console.log('\n── handing it over ──')
const synced = await cortex.syncToCortex('user-1')
check('the sync ran', synced.ok, synced.reason ?? '')
check('nothing was skipped', synced.skipped.length === 0, synced.skipped.join('; '))
check('entities landed', synced.entities >= 6, String(synced.entities))
check('and so did the edges', synced.relations === 3, String(synced.relations))

const rows = state.cortexEntities.get('chat-1') ?? []
check('the host graph holds them',
  rows.some(row => row.name === 'Kestrel') && rows.some(row => row.name === 'The Ash Door'),
  rows.map(row => row.name).join(', '))
check('a location is filed as a location',
  rows.find(row => row.name === 'The Ash Door')?.entityType === 'location')
check('facts came with the party',
  (rows.find(row => row.name === 'Kestrel')?.facts ?? []).some((fact: string) =>
    /Travels with the party/.test(fact)),
  JSON.stringify(rows.find(row => row.name === 'Kestrel')?.facts))
check('and the benched member is described as away',
  (rows.find(row => row.name === 'Vessa Corrin')?.facts ?? []).some((fact: string) =>
    /Away from the party/.test(fact)))
check('valence reached the host row',
  rows.find(row => row.name === 'Kestrel')?.emotionalValence?.friendship === 0.7,
  JSON.stringify(rows.find(row => row.name === 'Kestrel')?.emotionalValence))

const edges = state.cortexRelations.get('chat-1') ?? []
check('every edge starts from the player character',
  edges.every(edge => edge.source === rows.find(row => row.name === 'Syg')?.id),
  `${edges.length} edge(s)`)
check('and carries a sentiment in range',
  edges.every(edge => edge.sentiment >= -1 && edge.sentiment <= 1),
  edges.map(edge => `${edge.type}:${edge.sentiment}`).join(', '))

console.log('\n── syncing twice does not double the graph ──')
// The whole reason to upsert: a tracker commit fires this often, and a graph
// that grew a duplicate Kestrel every turn would be worse than no sync.
const countBefore = rows.length
const again = await cortex.syncToCortex('user-1')
check('the second run succeeds', again.ok)
check('and the graph is the same size',
  (state.cortexEntities.get('chat-1') ?? []).length === countBefore,
  `${countBefore} -> ${(state.cortexEntities.get('chat-1') ?? []).length}`)
check('with no duplicate edges',
  (state.cortexRelations.get('chat-1') ?? []).length === edges.length)

console.log('\n── the overlap is visible ──')
state.cortexArcs.set('chat-1', [{ tier: 1, summary: 'The party reached the Ash Door.' }])
const view = await cortex.readCortex('user-1')
check('the host side is read back', view.ok && view.entities.length > 0,
  `${view.entities.length} entities`)
check('the Multihog side is listed beside it', view.candidates.length > 0,
  `${view.candidates.length} candidates`)
check('and consolidated arcs come through',
  view.arcs.some(arc => /Ash Door/.test(arc.summary)),
  view.arcs.map(arc => arc.summary).join(' | '))

console.log('\n── failures are reported, not swallowed ──')
// One refused name is the difference between "it worked" and "it worked for
// everyone except her".
const realAddFacts = (spindle as any).memories.entities.addFacts
;(spindle as any).memories.entities.addFacts = async (id: string, facts: string[], u?: string) => {
  if (facts.some(fact => /Travels with the party/.test(fact))) throw new Error('nope')
  return realAddFacts(id, facts, u)
}
const partial = await cortex.syncToCortex('user-1')
check('the run still completes', partial.ok)
check('and names what it could not file', partial.skipped.length > 0,
  partial.skipped.slice(0, 2).join('; '))
;(spindle as any).memories.entities.addFacts = realAddFacts

console.log('\n── without the permission ──')
state.granted.delete('memories')
const denied = await cortex.cortexAvailable()
check('it says which permission is missing',
  !denied.ok && /memories/.test(denied.reason ?? ''), denied.reason ?? '')
check('and the sync refuses rather than throwing',
  !(await cortex.syncToCortex('user-1')).ok)
state.granted.add('memories')

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'cortex:read' })
await wait()
const sent = state.toFrontend.find(m => (m as any).type === 'cortex:state') as any
check('the panel is sent both sides',
  sent?.entities?.length > 0 && sent?.candidates?.length > 0,
  `${sent?.entities?.length} / ${sent?.candidates?.length}`)

state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'cortex:enable', enabled: false })
await wait()
check('the toggle round-trips',
  (state.toFrontend.find(m => (m as any).type === 'cortex:state') as any)?.enabled === false)

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'cortex test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
