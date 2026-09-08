/**
 * maps.ts — persistent maps.
 *
 *   bun tests/maps.ts
 *
 * `map-architect.js`, `map-updater.js` and `map-evolution.js` all came across
 * with the tracker closure, and `onGenerationEnded()` already called the
 * updater and evolution passes every turn. They did nothing, because a map has
 * to exist first and the only thing that creates one is the narrator model
 * calling the `CreateAreaMap` tool — which upstream registers from `index.js`,
 * the file this port replaces. So the tool was never offered and no map could
 * come into being.
 *
 * The other half is the connection: all three subsystems default to
 * SillyTavern's "main API", which does not exist here.
 */

import { emitHostEvent, installFakeSpindle, invokeTool } from './fake-spindle'

const state = installFakeSpindle()
// Maps are saved into a Locations lorebook named from the campaign prefix,
// which falls back to the chat id — so there has to be a chat open.
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'We descend into the crypt.', send_date: 0, swipe_id: 0,
  swipes: ['We descend into the crypt.'], swipe_dates: [0], extra: {},
  parent_message_id: null, branch_id: null, created_at: 0,
}])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const settle = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 250))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await settle()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

const { affectsMapRuntime, syncMapRuntime } = await import('../src/tracker/maps')

console.log('── the tool is offered to the model ──')
const status = await syncMapRuntime()
check('persistent maps are on by default', status.enabled, status.reason ?? '')
check('CreateAreaMap registered', status.toolRegistered, status.reason ?? '')
check('the host actually has it', state.tools.has('CreateAreaMap'),
  [...state.tools.keys()].join(', '))

console.log('\n── connections ──')
// Every subsystem ships pointing at SillyTavern's "main API". Character
// creation shipped the same way and generated against nothing until it was
// caught — twice.
check('map architect follows the tracker connection',
  settings.mapArchitectConnectionSource === 'profile'
    && settings.mapArchitectConnectionProfileId === settings.connectionProfileId,
  `${settings.mapArchitectConnectionSource} / ${settings.mapArchitectConnectionProfileId}`)
check('so do the updater and evolution passes',
  settings.mapRuntimeConnectionProfileId === settings.connectionProfileId
    && settings.mapEvolutionConnectionProfileId === settings.connectionProfileId)

// Pinning, following the tracker as it moves, and a profile that no longer
// exists are all connection behaviour rather than map behaviour — they live in
// tests/connections.ts, which covers every subsystem that has its own.

console.log('\n── the switch works both ways ──')
settings.syspromptModules.dungeon_reality_and_hidden_mapping = false
const off = await syncMapRuntime()
check('turning Persistent Maps off unregisters the tool',
  !off.toolRegistered && !state.tools.has('CreateAreaMap'),
  [...state.tools.keys()].join(', '))
check('and says why', /Persistent Maps/.test(off.reason ?? ''), off.reason ?? '')

settings.syspromptModules.dungeon_reality_and_hidden_mapping = true
check('turning it back on re-registers', (await syncMapRuntime()).toolRegistered)

settings.enabled = false
const disabled = await syncMapRuntime()
check('the master tracker switch also gates it',
  !disabled.toolRegistered && /tracker is switched off/.test(disabled.reason ?? ''),
  disabled.reason ?? '')
settings.enabled = true
await syncMapRuntime()

console.log('\n── settings that must re-sync ──')
check('a map setting re-syncs', affectsMapRuntime(['mapUpdaterRunEvery']))
check('the mapping module re-syncs',
  affectsMapRuntime(['syspromptModules.dungeon_reality_and_hidden_mapping']))
check('changing the tracker connection re-syncs',
  affectsMapRuntime(['connectionProfileId']),
  'the map passes inherit it')
check('an unrelated setting does not', !affectsMapRuntime(['use24hTime', 'lookbackMessages']))

console.log('\n── the model calls it ──')
// The Architect asks the model for the map body. A refusal is the interesting
// case: it must fail loudly rather than saving a half-built site.
state.generationResponse = 'I cannot do that.'
let toolResult = ''
let threw = ''
try {
  toolResult = await invokeTool(state, 'CreateAreaMap', {
    site: 'Cellar Crypt',
    entrance: 'Iron Gate',
    kind: 'DUNGEON',
    scale: 'SMALL',
    threat: 'LOW',
    prompt: 'A flooded crypt beneath the monument.',
    brief_description: 'A cramped, flooded crypt.',
  })
} catch (error) {
  threw = (error as Error).message
}
check('the tool reached the Map Architect', state.generations.length > 0,
  `${state.generations.length} generation(s)`)
check('an unusable reply fails loudly rather than saving a broken map',
  !!threw || /error|fail/i.test(toolResult),
  threw || toolResult.slice(0, 80))

const architectRequest = state.generations[state.generations.length - 1] as {
  model?: string
  messages?: Array<{ content: string }>
}
check('it went out with a model, not to a "main API" that does not exist',
  !!architectRequest?.model, String(architectRequest?.model))
const prompt = (architectRequest?.messages ?? []).map(m => m.content).join('\n')
check('the site brief reached the prompt', prompt.includes('Cellar Crypt'),
  prompt.slice(0, 60).replace(/\n/g, ' '))

console.log('\n── no map was invented ──')
// Nothing valid came back, so nothing should have been written.
check('no map lorebook was created',
  ![...state.books.values()].map(b => b.name).some(name => /cellar/i.test(name)),
  [...state.books.values()].map(b => b.name).join(', ') || '(none)')

console.log('\n── a map that actually saves ──')
// The Architect asks twice: topology, then the assets placed into it. The
// validator enforces the scale band (SMALL dungeon = 4-7 areas), connections
// by area *id*, and reachability from the entrance.
const area = (
  id: string,
  name: string,
  geometry: string,
  connections: Array<[string, string]>,
  knowledge = 'UNREVEALED',
): Record<string, unknown> => ({
  id,
  name,
  knowledge,
  geometry: [geometry],
  connections: connections.map(([to, detail]) => ({ to, state: 'OPEN', detail })),
})

const TOPOLOGY = JSON.stringify({
  version: 3,
  site: 'Cellar Crypt',
  kind: 'DUNGEON',
  threat: 'LOW',
  areas: [
    area('iron-gate', 'Iron Gate', 'A rusted portcullis over shallow water.',
      [['flooded-nave', 'A short flooded stair.']], 'VISITED'),
    area('flooded-nave', 'Flooded Nave', 'A collapsed nave, knee-deep in black water.',
      [['iron-gate', 'A short flooded stair.'], ['ossuary', 'A low arch of stacked femurs.']]),
    area('ossuary', 'Ossuary', 'Bone-lined walls, dry for the first time in years.',
      [['flooded-nave', 'A low arch of stacked femurs.'], ['reliquary', 'A cracked bronze door.']]),
    area('reliquary', 'Reliquary', 'A domed chamber holding a silted stone bier.',
      [['ossuary', 'A cracked bronze door.']]),
  ],
})
const ASSETS = JSON.stringify({
  assets: [{
    id: 'drowned-acolyte',
    kind: 'CREATURE',
    name: 'Drowned Acolyte',
    location: 'flooded-nave',
    state: 'DORMANT',
    knowledge: 'UNREVEALED',
    detail: 'Kneeling under the water, still holding a censer.',
    origin: 'INITIAL_MAP',
  }],
})

const booksBefore = state.books.size
state.generationQueue = [TOPOLOGY, ASSETS]
let saved = ''
let saveError = ''
try {
  saved = await invokeTool(state, 'CreateAreaMap', {
    site: 'Cellar Crypt',
    entrance: 'Iron Gate',
    kind: 'DUNGEON',
    scale: 'SMALL',
    threat: 'LOW',
    prompt: 'A flooded crypt beneath the monument.',
    brief_description: 'A cramped, flooded crypt.',
  })
} catch (error) {
  saveError = (error as Error).message
}
// `invokeTool` returns the tool's message, so a failure comes back as text
// rather than as a throw — checking only for a throw would pass either way.
check('the map was accepted',
  !saveError && !/fail|error/i.test(saved),
  saveError.slice(0, 140) || saved.slice(0, 140))
check('it told the model where the map lives',
  /Map saved to .+_Locations/.test(saved),
  saved.split('\n')[1] ?? '')
check('it took exactly two calls — topology, then contents',
  state.generationQueue.length === 0, `${state.generationQueue.length} reply/replies unused`)
check('a lorebook was written', state.books.size > booksBefore,
  [...state.books.values()].map(b => b.name).join(', ') || '(none)')

const entries = [...state.entries.values()] as Array<Record<string, any>>
const mapEntry = entries.find(entry =>
  /cellar crypt/i.test(String(entry.name ?? '') + String(entry.content ?? '')))
check('the site is in a lorebook entry', !!mapEntry, `${entries.length} entr(ies)`)
check('the rooms went in with it',
  /Flooded Nave/i.test(String(mapEntry?.content ?? '')),
  String(mapEntry?.content ?? '').slice(0, 70).replace(/\s+/g, ' '))
// The map body is hidden in entry metadata so a normal lorebook view does not
// hand the player the dungeon; only the brief description is in plain sight.
check('the brief description is the visible part',
  /cramped, flooded crypt/i.test(String(mapEntry?.content ?? '')))
check('the assets were placed into it',
  /Drowned Acolyte/i.test(String(mapEntry?.content ?? '')
    + JSON.stringify(mapEntry?.metadata ?? {})),
  'the creature should have landed in the flooded nave')

console.log('\n── the map belongs to the chat that asked for it ──')
/*
 * The Architect makes two model calls and saves afterwards, and the save asks
 * `ctx.chatId` again at that point — `router.js` calls its helper
 * `getLivePrefix()`, which is right in SillyTavern and wrong here. Switching
 * chats between the two calls filed a finished dungeon under
 * `<the other chat>_Locations` and still told the narrator "Map saved", so one
 * campaign believed in a map that had been written into another.
 */
state.messages.set('chat-2', [{
  id: 'm2', chat_id: 'chat-2', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'A different campaign entirely.', send_date: 0, swipe_id: 0,
  swipes: ['A different campaign entirely.'], swipe_dates: [0], extra: {},
  parent_message_id: null, branch_id: null, created_at: 0,
}] as never)
// A second site, because the Architect refuses to re-map one it has already
// done — and a refusal never reaches the model, so the switch would never fire.
// The `site` field has to match the tool's argument or validation rejects the
// topology, and a rejected pass writes nothing, which would make the checks
// below pass for the wrong reason. Both traps were hit while writing this.
const TOPOLOGY_2 = JSON.stringify({
  ...JSON.parse(TOPOLOGY) as Record<string, unknown>,
  site: 'Salt Stair',
})
state.generationQueue = [TOPOLOGY_2, ASSETS]
// Between the topology call and the assets call — where a real switch lands.
let architectCalls = 0
state.duringGeneration = async () => {
  if (++architectCalls !== 1) return
  await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-2' })
}
let switched = ''
try {
  switched = await invokeTool(state, 'CreateAreaMap', {
    site: 'Salt Stair', entrance: 'Iron Gate', kind: 'DUNGEON', scale: 'SMALL',
    threat: 'LOW', prompt: 'A stair cut down through salt.',
    brief_description: 'A narrow stair cut through salt.',
  })
} catch (error) {
  switched = 'THREW: ' + (error as Error).message
}
state.duringGeneration = undefined
await settle()

check('the user did end up in the other chat',
  SillyTavern.getContext().chatId === 'chat-2',
  String(SillyTavern.getContext().chatId))
// Asserted positively: "no chat-2 book" is also true of a pass that failed.
check('the map still saved, and into the chat that asked',
  /Map saved to chat_1_Locations/.test(switched),
  switched.split('\n')[1] ?? switched.slice(0, 110))
check('no lorebook exists for the chat switched to',
  ![...state.books.values()].some(b => /chat.?2/i.test(String(b.name))),
  [...state.books.values()].map(b => b.name).join(', '))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)

console.log(`\n${failures === 0 ? 'maps test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
