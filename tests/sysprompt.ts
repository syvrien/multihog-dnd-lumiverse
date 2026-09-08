/**
 * sysprompt.ts — the narrator's ruleset.
 *
 *   bun tests/sysprompt.ts
 *
 * `sysprompt.txt` is 54 sections teaching the narrator how to run the game the
 * tracker tracks: rolls, combat, quests, loot, XP, resting, the status footer,
 * party benching, mapping.
 *
 * It had never been delivered. Upstream assembles it in `index.js` and writes
 * the result into SillyTavern's Main prompt through `autoApplySysprompt` — a
 * preset surface with no Lumiverse equivalent, so the port left that action
 * throwing and nothing replaced it. The text sat bundled in `constants.js`,
 * read by nothing but the cartridge differ.
 *
 * Which meant the Narrator Configuration toggles looked live and, for the
 * narrator, mostly were not. These checks are about the text reaching the model
 * and the toggles changing it.
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'I search the room.', send_date: 0, swipe_id: 0,
  swipes: ['I search the room.'], swipe_dates: [0], extra: {},
  parent_message_id: null, branch_id: null, created_at: 0,
}])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 300))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

const {
  baseSyspromptText, buildSysprompt, listSections, setSectionEnabled,
} = await import('../src/tracker/sysprompt')

console.log('── the ruleset exists at all ──')
const base = await baseSyspromptText()
check('the shipped ruleset is bundled', base.length > 5000, `${base.length} chars`)
check('and carries its sections', /<quests>/.test(base) && /<loot>/.test(base))

console.log('\n── assembly ──')
const built = await buildSysprompt()
check('assembled something substantial', built.length > 2000, `${built.length} chars`)
check('kept the core rules', /<role>/.test(built) && /<combat>/.test(built))
check('CYOA is left out — the interceptor injects it separately',
  !/<CYOA_mode>/.test(built))

console.log('\n── the toggles actually change it ──')
// This is the point. Turning quests off should remove the quest rules from what
// the narrator is told, not merely from the tracker's own bookkeeping.
settings.syspromptModules.quests = true
const withQuests = await buildSysprompt()
settings.syspromptModules.quests = false
const withoutQuests = await buildSysprompt()

check('quests present when on', /<quests>/.test(withQuests))
check('quests gone when off', !/<quests>/.test(withoutQuests),
  `${withQuests.length} -> ${withoutQuests.length} chars`)
check('and the rest survived', withoutQuests.length > 1000 && /<role>/.test(withoutQuests))
settings.syspromptModules.quests = true

settings.syspromptModules.loot = false
check('loot is separately switchable', !/<loot>/.test(await buildSysprompt()))
settings.syspromptModules.loot = true

console.log('\n── format switches reach the rules, not just the display ──')
settings.use24hTime = false
const twelve = await buildSysprompt()
settings.use24hTime = true
const twentyFour = await buildSysprompt()
check('24-hour time rewrites the footer rule',
  twelve !== twentyFour && /24-hour/.test(twentyFour),
  '12h and 24h assemblies must differ')
settings.use24hTime = false

console.log('\n── dice ──')
settings.rngEnabled = false
const noRng = await buildSysprompt()
check('with dice off, the model is not told to call the dice tool',
  !/RollTheDice/.test(noRng), 'instructions to call a tool that is not registered')
settings.rngEnabled = true

console.log('\n── the Control Room list ──')
const sections = await listSections()
// Not a raw count — `extractTopLevelSections` finds 54 tags but only the
// orderable top-level rows become Control Room entries. What matters is that
// the sections a user would actually reach for are all there.
const tags = new Set(sections.map(row => row.tag))
const expected = ['role', 'combat', 'quests', 'loot', 'xp_system', 'narrative']
check('lists the sections a user would look for',
  expected.every(tag => tags.has(tag)),
  `${sections.length} rows; missing: ${expected.filter(t => !tags.has(t)).join(', ') || 'none'}`)
check('each has a readable label',
  sections.every(row => row.label.length > 0 && !row.label.includes('_')),
  sections.slice(0, 3).map(r => r.label).join(', '))
check('and reports what is on', sections.some(row => row.enabled))

const quests = sections.find(row => row.tag === 'quests')
if (!quests) {
  check('found the quests row', false)
} else {
  await setSectionEnabled('quests', false)
  check('toggling through the Control Room takes effect',
    !/<quests>/.test(await buildSysprompt()))
  await setSectionEnabled('quests', true)
  check('and back on', /<quests>/.test(await buildSysprompt()))
}

console.log('\n── it reaches the model ──')
// The whole point: assembly means nothing if the interceptor drops it.
const intercepted = await state.interceptors[0].handler([
  { role: 'user', content: 'I search the room.' },
] as never, { chatId: 'chat-1', userId: 'user-1', generationType: 'normal' } as never)

const system = (intercepted as Array<{ role: string; content: string }>)
  .filter(entry => entry.role === 'system').map(entry => entry.content).join('\n')
check('the ruleset is in the outgoing prompt', /<role>/.test(system),
  `${(intercepted as unknown[]).length} message(s)`)
check('ahead of the conversation',
  (intercepted as Array<{ role: string }>)[0]?.role === 'system')
check('the user\'s own message survived',
  (intercepted as Array<{ content: string }>).some(m => /search the room/.test(m.content)))

console.log('\n── switching it off ──')
settings.enabled = false
const off = await state.interceptors[0].handler([
  { role: 'user', content: 'I search the room.' },
] as never, { chatId: 'chat-1', userId: 'user-1', generationType: 'normal' } as never)
check('a disabled tracker sends no ruleset',
  !(off as Array<{ content: string }>).some(m => /<role>/.test(m.content)))
settings.enabled = true

console.log('\n── game systems ──')
const { listGameSystems, setGameSystemEnabled } = await import('../src/tracker/sysprompt')
check('none by default', (await listGameSystems()).length === 0)

// A Game System is a custom prompt section plus, usually, a tracked field.
settings.customSyspromptLibrary = [{
  id: 'lib-1', name: 'Hunger', enabled: true, origin: 'wizard',
  content: '<hunger>The party grows hungry as time passes.</hunger>',
}]
settings.gameSystems = [{
  id: 'gs-1', name: 'Hunger', enabled: true, syspromptLibraryId: 'lib-1',
  description: 'Track hunger over time',
}]
settings.syspromptSectionOrder = []

check('a game system is listed', (await listGameSystems()).length === 1)
check('its section reaches the narrator',
  /grows hungry/.test(await buildSysprompt()),
  'a custom system that never reaches the prompt does nothing')

await setGameSystemEnabled('gs-1', false)
check('switching it off removes the section',
  !/grows hungry/.test(await buildSysprompt()),
  'the system and its prompt section must agree')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'sysprompt test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
