/**
 * wizard.ts — the Game System Wizard, and the Campaign Records browser.
 *
 *   bun tests/wizard.ts
 *
 * The wizard turns a sentence into two linked halves: the rules the narrator
 * follows, and the tracker field carrying the number. Both are saved together
 * as a bundle, and the interesting failure is a half-saved one — rules with no
 * field to move, or a field with nothing that changes it.
 *
 * The records browser reads what the Lorebook Agent has filed. The grouping is
 * what matters: a book that matches no known suffix is the user's own lore, and
 * folding it into "People" would misattribute it.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'We cross the ash flats.', send_date: 0, swipe_id: 0,
  swipes: ['We cross the ash flats.'], swipe_dates: [0], extra: {},
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
  deleteGameSystem, draftGameSystem, saveGameSystem, wizardExamples,
} = await import('../src/tracker/wizard')

console.log('── the wizard ──')
check('offers example mechanics', (await wizardExamples()).length > 0,
  (await wizardExamples()).slice(0, 2).map(e => e.label).join(', '))
check('refuses an empty description', !(await draftGameSystem('  ')).ok)

// What the architect prompt asks the model to return.
state.generationResponse = `<meta name="Radiation" icon="☢️" needs_tracker="true"
  driver_time="true" driver_gm_annotation="false" driver_stated_fact="false"
  effect_owner="tracker" />
<gm_section tag="radiation_zones">
You track {{user}}'s exposure while they are in contaminated areas.
Exposure rises with time spent in a zone and falls with shelter or medication.
</gm_section>
<tracker_module tag="RADIATION" label="Radiation" icon="☢️">
Current exposure as a number from 0 to 100, and the current zone intensity.
</tracker_module>`

const drafted = await draftGameSystem('Radiation zones that build exposure over time.')
check('drafted a system', drafted.ok, drafted.reason ?? '')
check('named it', drafted.draft?.name === 'Radiation', String(drafted.draft?.name))
check('drafted the narrator rules',
  /exposure/i.test(drafted.draft?.gmContent ?? ''),
  (drafted.draft?.gmContent ?? '').slice(0, 40).replace(/\n/g, ' '))
check('drafted the tracked field',
  drafted.draft?.includeTracker === true && drafted.draft?.trackerTag === 'RADIATION',
  String(drafted.draft?.trackerTag))
check('read which driver moves the value',
  drafted.draft?.driverTime === true && drafted.draft?.driverGmAnnotation === false,
  'time-driven, as the meta said')

console.log('\n── nothing is saved until approved ──')
check('no system stored by drafting alone',
  (settings.gameSystems ?? []).length === 0,
  `${(settings.gameSystems ?? []).length} system(s)`)
check('and no rules added to the narrator prompt',
  !(settings.customSyspromptLibrary ?? []).some(
    (entry: Record<string, any>) => /radiation/i.test(String(entry.content ?? ''))))

console.log('\n── a tracked value needs something to move it ──')
const noDriver = await saveGameSystem(
  { ...drafted.draft!, driverTime: false, driverGmAnnotation: false, driverStatedFact: false },
  true,
)
check('refused with no driver', !noDriver.ok, noDriver.reason ?? '')
check('and said why usefully', /changes the value/.test(noDriver.reason ?? ''),
  noDriver.reason ?? '')

console.log('\n── saving ──')
const saved = await saveGameSystem(drafted.draft!, true)
check('saved', saved.ok, saved.reason ?? '')

const stored = (settings.gameSystems ?? [])[0]
check('the bundle exists', !!stored, JSON.stringify(Object.keys(stored ?? {})))
check('switched on as asked', stored?.enabled === true)
check('linked to its prompt section', !!stored?.syspromptLibraryId)
check('linked to its tracked field', !!stored?.customFieldTag,
  String(stored?.customFieldTag))

const { buildSysprompt } = await import('../src/tracker/sysprompt')
check('the rules reach the narrator',
  /exposure/i.test(await buildSysprompt()),
  'a system whose rules never reach the prompt does nothing')

console.log('\n── switching it off ──')
const { setGameSystemEnabled } = await import('../src/tracker/sysprompt')
await setGameSystemEnabled(String(stored.id), false)
check('the rules leave the prompt', !/exposure/i.test(await buildSysprompt()),
  'the bundle and its section must agree')
await setGameSystemEnabled(String(stored.id), true)

console.log('\n── deleting ──')
const libraryBefore = (settings.customSyspromptLibrary ?? []).length
await deleteGameSystem(String(stored.id))
check('the system is gone', (settings.gameSystems ?? []).length === 0)
check('its prompt section went with it',
  (settings.customSyspromptLibrary ?? []).length < libraryBefore
    && !/exposure/i.test(await buildSysprompt()),
  'orphaned rules would stay in every prompt with nothing to switch them off')
check('deleting something that is gone is refused',
  !(await deleteGameSystem('nope')).ok)

console.log('\n── campaign records ──')
const { readCampaignRecords, readRecordEntry } = await import('../src/tracker/records')

// Books the agent owns, plus one it does not.
const prefix = 'chat_1'
const { saveWorldInfo } = await import('../src/compat/world-info')
await saveWorldInfo(`${prefix}_NPCs`, {
  entries: {
    0: { uid: 0, comment: 'Bram', key: ['bram'], content: 'An innkeeper in Khelt.' },
    1: { uid: 1, comment: 'Alia', key: ['alia'], content: 'A courier with a limp.' },
  },
} as never)
await saveWorldInfo(`${prefix}_Quests`, {
  entries: { 0: { uid: 0, comment: 'The Ash Road', key: ['ash'], content: 'Cross the flats.' } },
} as never)
await saveWorldInfo('My Own Notes', {
  entries: { 0: { uid: 0, comment: 'House rules', key: [], content: 'We play with crits.' } },
} as never)

const records = await readCampaignRecords()
check('read the records', records.ok, records.reason ?? '')

const people = records.groups.find(group => group.id === 'npc')
const quests = records.groups.find(group => group.id === 'quest')
check('grouped people', people?.count === 2, String(people?.count))
check('grouped quests', quests?.count === 1, String(quests?.count))
check('counted what they cost', (people?.tokens ?? 0) > 0 && records.totalTokens > 0,
  `${records.totalTokens} tokens`)
check('sorted for reading, not by write order',
  people?.entries[0]?.label === 'Alia', String(people?.entries[0]?.label))

// A book the agent did not create is the user's own lore.
check('left an unrelated book out',
  !records.groups.some(group => group.entries.some(e => /House rules/.test(e.label))),
  'folding it into a group would misattribute it')

const entry = await readRecordEntry(people!.entries[0].id)
check('opened one in full', entry.ok && /courier/.test(entry.content ?? ''),
  entry.reason ?? (entry.content ?? '').slice(0, 30))
check('a malformed id is refused', !(await readRecordEntry('nonsense')).ok)

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'records:read' })
await wait()
const pushed = state.toFrontend.find(m => (m as any).type === 'records:state') as any
check('the panel is sent the records', pushed?.ok === true && pushed.groups.length > 0,
  `${pushed?.groups?.length ?? 0} group(s)`)

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 110)}`)

console.log(`\n${failures === 0 ? 'wizard test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
