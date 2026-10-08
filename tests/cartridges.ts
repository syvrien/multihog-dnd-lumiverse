/**
 * cartridges.ts — saved configurations.
 *
 *   bun tests/cartridges.ts
 *
 * A cartridge is a named snapshot of every setting: the narrator ruleset, Game
 * Systems, the agent's record types, dice, display. Configuration only — no
 * campaign, no characters, no lore. That boundary is the thing worth pinning:
 * sharing a cartridge must hand over a setup, never a playthrough.
 *
 * Selective load is the other half. Someone who takes a cartridge for its Game
 * Systems will not expect their dice settings to move with it, so anything they
 * did not tick has to come through untouched.
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
const wait = (ms = 350): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

const {
  deleteCartridge, describeCurrent, exportCartridge, importCartridge,
  inspectCartridge, listCartridges, loadCartridge, saveCurrentAsCartridge,
} = await import('../src/tracker/cartridges')

console.log('── what a setup is made of ──')
const groups = await describeCurrent()
check('divides into named groups', groups.length >= 3,
  groups.map(g => g.label).slice(0, 3).join(', '))

// Connection ids are deliberately *not* in the payload, so a shared cartridge
// cannot repoint someone's subsystems at profiles that do not exist for them.
const shape = JSON.stringify(groups)
check('no connection settings travel in a cartridge',
  !/ConnectionProfileId|ConnectionSource/.test(shape),
  'a shared setup must not carry your profile ids')

// The Lorebook Agent group reads as changed on any live install: its module
// instructions are rebuilt from current settings, so they never match the raw
// factory snapshot. The flag is a hint, not a claim about what the user did.
const trackerStock = groups.find(group => group.id === 'stateTracker')
check('an untouched group reads as stock', trackerStock?.changed === false,
  groups.filter(g => g.changed).map(g => g.label).join(', ') || 'all stock')

console.log('\n── saving the current setup ──')
// A grim setup: no dice tools, 24-hour clock, quests off.
settings.rngToolD20 = true
settings.use24hTime = true
settings.syspromptModules.quests = false

const marked = await describeCurrent()
check('changed groups are flagged', marked.some(group => group.changed),
  marked.filter(g => g.changed).map(g => g.label).join(', '))

check('a nameless cartridge is refused', !(await saveCurrentAsCartridge('  ', '', '')).ok)
const saved = await saveCurrentAsCartridge('Grim', 'Low fantasy, no quest log', '🗡️')
check('saved', saved.ok, saved.reason ?? '')

const list = await listCartridges()
check('it is on the shelf', list.length === 1 && list[0].name === 'Grim',
  list.map(c => c.name).join(', '))

console.log('\n── it holds settings, not a campaign ──')
settings.currentMemo = '[CHARACTER]\nSyg\n[/CHARACTER]'
const exported = await exportCartridge(list[0].id)
check('exported', exported.ok, exported.reason ?? '')
check('and carries no memo, chat state or lore',
  !/currentMemo|chatStates|Syg/.test(exported.text ?? ''),
  'sharing a setup must not share a playthrough')
check('but does carry the settings', /use24hTime/.test(exported.text ?? ''))

console.log('\n── loading only part of one ──')
// Move everything away from what the cartridge holds.
settings.rngToolD20 = false
settings.use24hTime = false
settings.syspromptModules.quests = true
settings.npcRelationshipMax = 999

const detail = await inspectCartridge(list[0].id)
check('can be opened before loading', detail.ok && !!detail.groups?.length,
  detail.reason ?? `${detail.groups?.length ?? 0} group(s)`)

const trackerGroup = detail.groups!.find(group => group.id === 'stateTracker')
check('the tracker group is there', !!trackerGroup, trackerGroup?.label ?? '')

const loaded = await loadCartridge(list[0].id, ['stateTracker'])
check('loaded just that group', loaded.ok, loaded.reason ?? '')
check('the settings in it came back',
  settings.use24hTime === true && settings.syspromptModules.quests === false,
  `24h=${settings.use24hTime} quests=${settings.syspromptModules.quests}`)
// The whole point of selective load.
check('and everything else was left alone',
  settings.npcRelationshipMax === 999,
  'a group nobody ticked must not move')

check('loading nothing is refused', !(await loadCartridge(list[0].id, ['nope'])).ok)
check('loading a cartridge that is gone is refused', !(await loadCartridge('nope')).ok)

console.log('\n── sharing one ──')
check('nonsense is refused', !(await importCartridge('not json')).ok)
check('other JSON is refused',
  !(await importCartridge('{"format":"something-else"}')).ok,
  (await importCartridge('{"format":"something-else"}')).reason ?? '')
check('a cartridge with no settings is refused',
  !(await importCartridge('{"format":"multihog-game-cartridge"}')).ok)

const importedBefore = settings.use24hTime
const imported = await importCartridge(exported.text ?? '')
check('imported', imported.ok, imported.reason ?? '')
check('under a distinct name', imported.name !== 'Grim', String(imported.name))
check('as a second cartridge, not a replacement',
  (await listCartridges()).length === 2)
// Importing must not change how the game plays until asked.
check('and did not apply itself', settings.use24hTime === importedBefore,
  'an import that silently reconfigured you would be a nasty surprise')

console.log('\n── deleting ──')
await deleteCartridge(list[0].id)
check('gone', (await listCartridges()).length === 1)
check('deleting one that is gone is refused', !(await deleteCartridge(list[0].id)).ok)

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'cartridge:read' })
await wait()
const pushed = state.toFrontend.find(m => (m as any).type === 'cartridge:state') as any
check('the panel is sent the shelf and the current setup',
  Array.isArray(pushed?.cartridges) && Array.isArray(pushed?.current),
  `${pushed?.cartridges?.length ?? 0} saved`)

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 110)}`)
check('no errors', errors.length === 0, errors[0]?.message?.slice(0, 80) ?? '')

console.log(`\n${failures === 0 ? 'cartridges test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
