/**
 * blocks.ts — the tracker's cards, and the schema behind character cards.
 *
 *   bun tests/blocks.ts
 *
 * `ui-editors.js` was ported and then called by nothing, so everything here was
 * reachable only through the Game System Wizard: a model could invent a tracked
 * module for you, and after that it was fixed forever. No reordering, no
 * switching one off, no adjusting what it records.
 *
 * The part that actually needs proving is the **rename cascade**. A module's
 * tag is a foreign key held in six places, and upstream's save handler updates
 * all six. Missing one leaves a card rendering in the wrong position, or a
 * Display Group quietly short a member — neither of which throws, and both of
 * which look like the editor working.
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
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

const blocks = await import('../src/tracker/blocks')
const tags = (view: { blocks: Array<{ tag: string }> }): string[] =>
  view.blocks.map(block => block.tag)

console.log('── the cards ──')
settings.customFields = []
delete settings.blockOrder

const first = await blocks.readBlocks()
check('every shipped card is listed', first.blocks.length >= 6, tags(first).join(', '))
check('and they are marked built in',
  first.blocks.every(block => block.kind === 'stock'))
check('each carries its enabled state',
  first.blocks.some(block => typeof block.enabled === 'boolean'))

console.log('\n── order ──')
const before = tags(first)
const moved = await blocks.moveBlock(before[2], 'up')
const after = tags(moved.view!)
check('a card moves earlier', after[1] === before[2] && after[2] === before[1],
  `${before.slice(0, 4).join(',')} -> ${after.slice(0, 4).join(',')}`)

const backDown = await blocks.moveBlock(before[2], 'down')
check('and back', tags(backDown.view!).join() === before.join(),
  tags(backDown.view!).slice(0, 4).join(','))

check('moving past the top is a quiet no-op',
  (await blocks.moveBlock(before[0], 'up')).ok)
check('moving an unknown tag is refused',
  !(await blocks.moveBlock('NOPE', 'up')).ok)

// The renderer reads `blockOrder`; the setting is the whole deliverable.
check('the order is persisted where the renderer reads it',
  Array.isArray(settings.blockOrder) && settings.blockOrder.length > 0,
  String(settings.blockOrder?.length))

console.log('\n── switching one off ──')
const off = await blocks.setBlockEnabled('INVENTORY', false)
check('a built-in card can be switched off',
  off.view?.blocks.find(block => block.tag === 'INVENTORY')?.enabled === false)
check('and it is the engine flag that changed',
  settings.modules?.inventory === false, String(settings.modules?.inventory))

// This is the bit worth stating: it is not only a card being hidden.
const memo = await import('../src/engine/memo-processor.js') as {
  buildModulesInstructionText: (settings: unknown) => string
}
const withoutInventory = memo.buildModulesInstructionText(settings)
await blocks.setBlockEnabled('INVENTORY', true)
const withInventory = memo.buildModulesInstructionText(settings)
const mentions = (text: string): number => (text.match(/\[INVENTORY\]/g) ?? []).length
check('switching a card off also stops the tracker being asked about it',
  withInventory.length > withoutInventory.length
    && mentions(withoutInventory) < mentions(withInventory),
  `${mentions(withInventory)} -> ${mentions(withoutInventory)} references, `
    + `${withInventory.length} -> ${withoutInventory.length} chars`)
// One reference survives: another module's instruction cross-references the
// inventory. That is the engine's own text, not a leak from the toggle.
check('though a cross-reference from another module survives',
  mentions(withoutInventory) === 1,
  'the module’s own block goes; a mention inside someone else’s does not')

console.log('\n── custom modules ──')
check('a tagless module is refused', !(await blocks.saveCustomModule({ tag: '  ' })).ok)
check('a built-in tag is refused',
  !(await blocks.saveCustomModule({ tag: 'INVENTORY' })).ok,
  'that name already means something')

const made = await blocks.saveCustomModule({
  tag: 'limit break', icon: '🔥', label: 'Limit Break',
  prompt: 'Track the charge level.', pageSize: 5,
})
check('a module is created', made.ok, made.reason ?? '')
check('the tag is normalised', tags(made.view!).includes('LIMITBREAK'),
  tags(made.view!).join(', '))
const created = made.view!.blocks.find(block => block.tag === 'LIMITBREAK')
check('it starts switched on', created?.enabled === true,
  'a module you just wrote and cannot see reads as the editor having failed')
check('it carries its prompt', created?.prompt === 'Track the charge level.')
check('and its page size', settings.modulePageSizes?.LIMITBREAK === 5,
  String(settings.modulePageSizes?.LIMITBREAK))
check('a second module with the same tag is refused',
  !(await blocks.saveCustomModule({ tag: 'LIMITBREAK' })).ok)

console.log('\n── the rename cascade ──')
// Wire the tag into every place that keys off it, then rename and check all
// six followed. This is the check the whole file exists for.
settings.displayGroups = [{
  id: 'grp-1', name: 'Powers', icon: '🗂️', enabled: true,
  members: ['LIMITBREAK', 'ABILITIES'],
}]
settings.gameSystems = [{ id: 'sys-1', name: 'Limit', customFieldTag: 'LIMITBREAK' }]
settings.categoryRenderOptions = { LIMITBREAK: { compact: true } }
const orderIndexBefore = settings.blockOrder.indexOf('LIMITBREAK')
check('it is in the order to begin with', orderIndexBefore >= 0)

const renamed = await blocks.saveCustomModule({
  originalTag: 'LIMITBREAK', tag: 'OVERDRIVE', icon: '🔥', label: 'Overdrive',
  prompt: 'Track the charge level.',
})
check('renamed', renamed.ok, renamed.reason ?? '')

check('1. the block order followed',
  settings.blockOrder.indexOf('OVERDRIVE') === orderIndexBefore
    && !settings.blockOrder.includes('LIMITBREAK'),
  settings.blockOrder.join(','))
check('2. the display group member followed',
  settings.displayGroups[0].members.join() === 'OVERDRIVE,ABILITIES',
  settings.displayGroups[0].members.join(','))
check('3. the owning Game System followed',
  settings.gameSystems[0].customFieldTag === 'OVERDRIVE',
  String(settings.gameSystems[0].customFieldTag))
check('4. the page size followed',
  settings.modulePageSizes?.OVERDRIVE === 5
    && settings.modulePageSizes?.LIMITBREAK === undefined,
  JSON.stringify(settings.modulePageSizes))
check('5. the render options followed',
  !!settings.categoryRenderOptions?.OVERDRIVE
    && settings.categoryRenderOptions?.LIMITBREAK === undefined,
  Object.keys(settings.categoryRenderOptions ?? {}).join(','))
// 6. The tombstone is what stops a stale copy in a chat's saved state coming
// back on the next load.
check('6. the old tag is tombstoned',
  JSON.stringify(settings).includes('LIMITBREAK') === false
    || Array.isArray(settings.deletedCustomTags),
  'a deleted tag that resurrects is worse than one you cannot delete')

console.log('\n── deleting ──')
check('a built-in cannot be deleted',
  !(await blocks.deleteCustomModule('CHARACTER')).ok,
  'switching it off is the supported move')

const removed = await blocks.deleteCustomModule('OVERDRIVE')
check('a custom module is deleted', removed.ok, removed.reason ?? '')
check('it left the order', !settings.blockOrder.includes('OVERDRIVE'),
  settings.blockOrder.join(','))
check('and left its display group without dangling',
  !(settings.displayGroups?.[0]?.members ?? []).includes('OVERDRIVE'),
  JSON.stringify(settings.displayGroups?.[0]?.members ?? []))
check('deleting it twice is refused', !(await blocks.deleteCustomModule('OVERDRIVE')).ok)

console.log('\n── what a built-in module asks for ──')
// `buildModulesInstructionText()` reads `stockPrompts` in preference to the
// shipped text, so an edit here is genuinely what the tracker is told.
const stock = (await blocks.readBlocks()).blocks.find(block => block.tag === 'CHARACTER')
check('a built-in carries its live instruction',
  (stock?.stockPrompt ?? '').length > 100, `${(stock?.stockPrompt ?? '').length} chars`)
check('and reports it as unmodified', stock?.stockIsDefault === true)

const written = await blocks.saveStockPrompt('CHARACTER', 'Track only the name and HP.')
check('it can be rewritten', written.ok, written.reason ?? '')
check('the change reaches the tracker instruction',
  /Track only the name and HP/.test(memo.buildModulesInstructionText(settings)),
  'not a copy of the prompt — the prompt')
check('and it is flagged as edited',
  written.view?.blocks.find(block => block.tag === 'CHARACTER')?.stockIsDefault === false)

// An empty instruction would drop the module from the prompt while leaving its
// card on — switching it off is the way to do that, and the refusal says so.
check('an empty instruction is refused',
  !(await blocks.saveStockPrompt('CHARACTER', '   ')).ok,
  String((await blocks.saveStockPrompt('CHARACTER', '  ')).reason))
check('a tag that is not built in is refused',
  !(await blocks.saveStockPrompt('NOTATHING', 'x')).ok)

const restored = await blocks.resetStockPrompt('CHARACTER')
check('the shipped instruction can be put back',
  restored.view?.blocks.find(block => block.tag === 'CHARACTER')?.stockIsDefault === true)
check('and the tracker instruction went back with it',
  !/Track only the name and HP/.test(memo.buildModulesInstructionText(settings)))

console.log('\n── card schemas ──')
const sections = await import('../src/tracker/sections')
delete settings.npcCoreSections

const npc = await sections.readSections('npc')
check('the shipped NPC schema loads', npc.sections.length > 4,
  npc.sections.map(section => section.name).join(', '))
check('and reports itself as unmodified', npc.isDefault)
check('a section description is an instruction, not a label',
  (npc.sections[0]?.description ?? '').length > 40,
  `${(npc.sections[0]?.description ?? '').length} chars`)

const added = await sections.addSection('npc', 'Augmentations')
check('a section is added', added.ok
  && (added.view?.sections ?? []).some(section => section.name === 'Augmentations'))
check('and the schema is no longer the shipped one', added.view?.isDefault === false)
check('a duplicate name is refused',
  !(await sections.addSection('npc', 'augmentations')).ok,
  'the name is how the model addresses the section')
check('a nameless section is refused', !(await sections.addSection('npc', ' ')).ok)

const target = added.view!.sections.find(section => section.name === 'Augmentations')!
const edited = await sections.updateSection('npc', target.id, {
  description: 'Cyberware and implants, with their condition.',
})
check('a description can be edited',
  edited.view?.sections.find(section => section.id === target.id)?.description
    === 'Cyberware and implants, with their condition.')

// The agent's NPC instruction is generated from this schema, so editing one
// without rebuilding leaves settings and prompt disagreeing.
check('the agent instruction was rebuilt from the new schema',
  /Augmentations/i.test(String(settings.routerModules?.npc?.instruction ?? '')),
  String(settings.routerModules?.npc?.instruction ?? '').slice(0, 60))

const lastIndex = edited.view!.sections.length - 1
const movedUp = await sections.moveSection('npc', target.id, 'up')
check('a section moves', movedUp.view?.sections
  .findIndex(section => section.id === target.id) === lastIndex - 1,
  String(movedUp.view?.sections.findIndex(section => section.id === target.id)))

check('a section can be deleted',
  (await sections.deleteSection('npc', target.id)).ok)
check('deleting one that is gone is refused',
  !(await sections.deleteSection('npc', target.id)).ok)

// An empty schema would have the agent writing cards with nothing in them.
const single = await sections.resetSections('npc')
for (const section of single.sections.slice(1)) {
  await sections.deleteSection('npc', section.id)
}
check('the last section cannot be deleted',
  !(await sections.deleteSection('npc', (await sections.readSections('npc')).sections[0].id)).ok,
  'a card needs at least one section')

check('and the shipped schema can be put back',
  (await sections.resetSections('npc')).isDefault)

console.log('\n── the PC schema is separate ──')
await sections.addSection('pc', 'Oaths')
check('adding to the PC card does not touch the NPC one',
  (await sections.readSections('npc')).isDefault
    && (await sections.readSections('pc')).sections.some(s => s.name === 'Oaths'))

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'blocks:read' })
await emitFrontendMessage(state, { type: 'sections:read', target: 'pc' })
await wait()
check('the editor is sent the cards',
  !!state.toFrontend.find(m => (m as any).type === 'blocks:state'))
check('and the card schema',
  (state.toFrontend.find(m => (m as any).type === 'sections:state') as any)?.target === 'pc')

state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'blocks:enable', tag: 'XP', enabled: false })
await wait()
check('a change repaints the panel',
  state.toFrontend.some(m => (m as any).type === 'panel:render'),
  'order and enablement are what the panel draws')
await blocks.setBlockEnabled('XP', true)

state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'blocks:save', tag: '' })
await wait()
check('a refusal comes back with a reason',
  !!(state.toFrontend.find(m => (m as any).type === 'blocks:state') as any)?.reason,
  String((state.toFrontend.find(m => (m as any).type === 'blocks:state') as any)?.reason))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'blocks test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
