/**
 * workshop.ts — looking at maps, watching the agent, and instructing subsystems.
 *
 *   bun tests/workshop.ts
 *
 * Three gaps that shared a shape: data the framework already had, with nothing
 * that displayed or drove it.
 *
 *   - the Architect stored real maps and none could be looked at
 *   - `routerLog` and `activeRouterKeys` were written and read by nothing
 *   - the Ask box reached only the State Tracker
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'We enter the crypt.', send_date: 0, swipe_id: 0,
  swipes: ['We enter the crypt.'], swipe_dates: [0], extra: {},
  parent_message_id: null, branch_id: null, created_at: 0,
}])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 350): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

console.log('── a map to look at ──')
// Build one through the Architect, so the stored shape is the real one rather
// than a fixture that happens to satisfy the renderer.
const area = (
  id: string, name: string, geometry: string,
  connections: Array<[string, string]>, knowledge = 'UNREVEALED',
): Record<string, unknown> => ({
  id, name, knowledge, geometry: [geometry],
  connections: connections.map(([to, detail]) => ({ to, state: 'OPEN', detail })),
})

// On creation the engine allows exactly one VISITED area — the entrance —
// unless the whole site is established as familiar. DISCOVERED is what the
// party can see from there but has not walked into.
state.generationQueue = [
  JSON.stringify({
    version: 3, site: 'Cellar Crypt', kind: 'DUNGEON', threat: 'LOW',
    areas: [
      area('iron-gate', 'Iron Gate', 'A rusted portcullis.',
        [['flooded-nave', 'A flooded stair.']], 'VISITED'),
      area('flooded-nave', 'Flooded Nave', 'Black water to the knee.',
        [['iron-gate', 'A flooded stair.'], ['ossuary', 'A low arch.']], 'DISCOVERED'),
      area('ossuary', 'Ossuary', 'Bone-lined walls.',
        [['flooded-nave', 'A low arch.'], ['reliquary', 'A bronze door.']]),
      area('reliquary', 'Reliquary', 'A silted stone bier.',
        [['ossuary', 'A bronze door.']]),
    ],
  }),
  JSON.stringify({
    assets: [{
      id: 'drowned-acolyte', kind: 'CREATURE', name: 'Drowned Acolyte',
      location: 'flooded-nave', state: 'DORMANT', knowledge: 'UNREVEALED',
      detail: 'Kneeling under the water.', origin: 'INITIAL_MAP',
    }],
  }),
]

const { invokeTool } = await import('./fake-spindle')
await invokeTool(state, 'CreateAreaMap', {
  site: 'Cellar Crypt', entrance: 'Iron Gate', kind: 'DUNGEON', scale: 'SMALL',
  threat: 'LOW', prompt: 'A flooded crypt.', brief_description: 'A flooded crypt.',
})
await wait()

const { listMaps, renderMap } = await import('../src/tracker/map-view')
const listed = await listMaps()
check('found the stored map', listed.ok && listed.maps.length === 1,
  listed.reason ?? `${listed.maps.length} map(s)`)
check('named the site', listed.maps[0]?.site === 'Cellar Crypt', String(listed.maps[0]?.site))
check('counted areas and how many are explored',
  listed.maps[0]?.areas === 4 && listed.maps[0]?.visited === 1,
  `${listed.maps[0]?.visited}/${listed.maps[0]?.areas}`)

console.log('\n── drawing it ──')
const drawn = await renderMap(listed.maps[0].id)
check('rendered', drawn.ok, drawn.reason ?? '')
check('produced an SVG', /<svg/i.test(drawn.svg ?? ''), `${(drawn.svg ?? '').length} chars`)
check('drew the rooms the party has seen', /Iron Gate/.test(drawn.svg ?? ''))
check('and a readable write-up', (drawn.detail ?? '').length > 0,
  `${(drawn.detail ?? '').length} chars`)

// The map is the GM's. Rendering the unexplored half into a panel the player is
// looking at spoils the thing the Architect was asked to build.
check('hides undiscovered areas by default',
  !/Reliquary/.test(drawn.svg ?? ''),
  'player-facing unless asked otherwise')

const revealed = await renderMap(listed.maps[0].id, true)
check('reveals them when asked', /Reliquary/.test(revealed.svg ?? ''))
check('a bad id is refused', !(await renderMap('nonsense')).ok)

console.log('\n── what the agent is doing ──')
const { deactivateKey, readAgentView } = await import('../src/tracker/agent-view')
settings.routerLog = [
  { time: '09:17 PM', reason: 'Targeted cleanup', activate: [], deactivate: [],
    record: ['a::1'], rewrite: [], delete: [] },
  { time: '09:15 PM', reason: 'Agent tool update', activate: ['a::2'], deactivate: [],
    record: [], rewrite: ['a::3'], delete: [] },
]
settings.activeRouterKeys = ['chat_1_NPCs::0', 'chat_1_Locations::2']
settings.routerMaxActivations = 12

const view = await readAgentView()
check('read the recent passes', view.log.length === 2, String(view.log.length))
check('summarised what a pass changed',
  view.log[1]?.activated === 1 && view.log[1]?.rewritten === 1,
  JSON.stringify(view.log[1]))
check('listed what is in the prompt now', view.keys.length === 2,
  view.keys.map(k => k.label).join(', '))
check('labelled them readably, not by uid',
  /NPCs #0/.test(view.keys[0]?.label ?? ''), String(view.keys[0]?.label))
check('reported the cap', view.maxActive === 12, String(view.maxActive))

await deactivateKey('chat_1_NPCs::0')
check('dropping one takes it out of the prompt',
  !settings.activeRouterKeys.includes('chat_1_NPCs::0'),
  settings.activeRouterKeys.join(', '))
check('and leaves the rest', settings.activeRouterKeys.includes('chat_1_Locations::2'))

console.log('\n── the terminal ──')
const { runTerminal, TARGET_LABELS } = await import('../src/tracker/terminal')
check('names every target', Object.keys(TARGET_LABELS).length === 5,
  Object.values(TARGET_LABELS).join(', '))
check('an empty instruction is refused', !(await runTerminal('tracker', '   ')).ok)

settings.currentMemo = '[CHARACTER]\nSyg\nHP: 8/8\n[/CHARACTER]'
state.generationQueue = []
state.generationResponse = '[CHARACTER]\nSyg\nHP: 12/12\n[/CHARACTER]'
const tracker = await runTerminal('tracker', 'Syg has 12 HP.')
check('the tracker target updates the memo',
  tracker.ok && String(settings.currentMemo).includes('12/12'),
  tracker.output)

// The Architect is driven by a tool call with a structured brief; free text has
// nowhere to go, and inventing a brief would build a map nobody described.
const architect = await runTerminal('map_architect', 'make a castle')
check('the Architect says why it cannot take an instruction',
  !architect.ok && /CreateAreaMap/.test(architect.output), architect.output.slice(0, 60))

state.generationResponse = 'No changes needed.'
const updater = await runTerminal('map_updater', 'the inn burned down')
// Skipped is not failed — reporting it as one sends the user hunting a bug.
check('a skipped map pass says so plainly',
  !/error|threw/i.test(updater.output), updater.output.slice(0, 70))

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'maps:list' })
await emitFrontendMessage(state, { type: 'agent:read' })
await wait()
check('the panel is sent the maps',
  !!state.toFrontend.find(m => (m as any).type === 'maps:list'))
check('and the agent view',
  !!state.toFrontend.find(m => (m as any).type === 'agent:view'))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 110)}`)

console.log(`\n${failures === 0 ? 'workshop test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
