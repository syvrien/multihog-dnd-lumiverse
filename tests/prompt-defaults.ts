/**
 * prompt-defaults.ts — telling you when an update changed the shipped prompts,
 * and folding tracker cards together.
 *
 *   bun tests/prompt-defaults.ts
 *
 * Two features that share a shape: settings the engine has always read and the
 * port never let you reach.
 *
 * For the prompt dialog, the assertions that matter are about **silence**. It
 * must not appear on a fresh install, must not appear when nothing shipped has
 * changed, and must not reappear once answered — a dialog that opens on every
 * load is one people learn to dismiss without reading, which defeats the point
 * of having it.
 *
 * For Display Groups, the point is that `normalizeDisplayGroups` stays the only
 * writer: a module in two groups, an empty group, an excluded tag all have
 * defined outcomes, and the editor must not be able to produce a shape the
 * renderer would choke on.
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

const {
  acknowledgePromptDefaults, applyPromptDefaults, checkPromptDefaults,
} = await import('../src/tracker/prompt-defaults')

console.log('── a fresh install says nothing ──')
delete settings.lastSeenPromptDefaultsSnapshot
delete settings.lastSeenPromptDefaultsFingerprint
const fresh = await checkPromptDefaults()
check('nothing pending', !fresh.pending, fresh.reason ?? '')
check('and it recorded what shipped',
  !!settings.lastSeenPromptDefaultsFingerprint,
  'otherwise the next load would claim everything changed')

console.log('\n── nothing changed, nothing shown ──')
check('a second look is still quiet', !(await checkPromptDefaults()).pending)

console.log('\n── an update moves a shipped prompt ──')
// Simulate the update by ageing the acknowledged snapshot: change the text
// this install believes shipped last time, and the current bundle now differs.
const stored = JSON.parse(JSON.stringify(settings.lastSeenPromptDefaultsSnapshot))
check('the snapshot holds the tracker prompts',
  !!stored.tracker, Object.keys(stored).join(', '))
const trackerKey = Object.keys(stored.tracker)[0]
stored.tracker[trackerKey] = `OLD SHIPPED TEXT\n${String(stored.tracker[trackerKey] ?? '')}`
settings.lastSeenPromptDefaultsSnapshot = stored
delete settings.lastSeenPromptDefaultsFingerprint

const report = await checkPromptDefaults()
check('it noticed', report.pending, report.reason ?? '')
check('and named the category',
  report.changed.some(category => category.id === 'tracker'),
  report.changed.map(category => category.id).join(', '))

const tracker = report.changed.find(category => category.id === 'tracker')!
check('with a human label', /State Tracker/i.test(tracker.label), tracker.label)
check('and a real line diff',
  tracker.blocks.some(block => block.deletions > 0 || block.additions > 0),
  tracker.blocks.map(b => `${b.label} +${b.additions}/-${b.deletions}`).join(', '))
check('the diff names the removed line',
  tracker.blocks.some(block =>
    block.lines.some(line => line.type === 'del' && /OLD SHIPPED TEXT/.test(line.text))),
  'the point of the diff is seeing what actually moved')

console.log('\n── the badge is what makes it actionable ──')
check('a badge was worked out for each category',
  report.changed.every(category => typeof category.badge === 'string' && category.badge),
  report.changed.map(category => `${category.id}=${category.badge}`).join(', '))

console.log('\n── keeping yours still counts as an answer ──')
const kept = await applyPromptDefaults([])
check('accepted', kept.ok && kept.applied.length === 0)
check('and the dialog does not come back',
  !(await checkPromptDefaults()).pending,
  'otherwise it reappears on every single load until you give in')

console.log('\n── taking the new defaults ──')
settings.lastSeenPromptDefaultsSnapshot = stored
delete settings.lastSeenPromptDefaultsFingerprint
settings.systemPromptTemplate = 'MY OWN TRACKER PROMPT'
settings.mapArchitectSystemPrompt = 'MY OWN MAP PROMPT'

const applied = await applyPromptDefaults(['tracker'])
check('it applied what was asked for',
  applied.ok && applied.applied.join() === 'tracker', applied.applied.join(', '))
check('the customised tracker prompt was replaced',
  settings.systemPromptTemplate !== 'MY OWN TRACKER PROMPT',
  String(settings.systemPromptTemplate).slice(0, 40))
// The whole reason for per-category checkboxes.
check('and an untouched category was left alone',
  settings.mapArchitectSystemPrompt === 'MY OWN MAP PROMPT',
  String(settings.mapArchitectSystemPrompt))
check('answering acknowledged it', !(await checkPromptDefaults()).pending)

console.log('\n── through the panel ──')
settings.lastSeenPromptDefaultsSnapshot = stored
delete settings.lastSeenPromptDefaultsFingerprint
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'prompts:check' })
await wait()
const sent = state.toFrontend.find(m => (m as any).type === 'prompts:changed') as any
check('the panel is told', sent?.pending === true, String(sent?.reason ?? ''))
check('with the categories and diffs', (sent?.changed?.length ?? 0) > 0,
  (sent?.changed ?? []).map((c: any) => c.id).join(', '))

state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'prompts:apply', categories: [] })
await wait()
check('and the answer is acknowledged',
  (state.toFrontend.find(m => (m as any).type === 'prompts:applied') as any)?.ok === true)

// ───────────────────────────────────────────────────────────────────────────

console.log('\n── display groups ──')
const groups = await import('../src/tracker/display-groups')

settings.displayGroups = []
settings.displayGroupsEnabled = false

const view = await groups.readDisplayGroups()
check('it lists the groupable modules', view.modules.length > 0,
  view.modules.map(m => m.tag).join(', '))
// These render with their own layout; folding one into a group makes a card
// that cannot draw itself.
for (const excluded of ['COMBAT', 'QUESTS']) {
  check(`${excluded} is not offered`, !view.modules.some(m => m.tag === excluded))
}
check('nothing is grouped yet', view.groups.length === 0)

console.log('\n── making one ──')
check('a nameless group is refused', !(await groups.addDisplayGroup('  ', 'INVENTORY')).ok)
const made = await groups.addDisplayGroup('Kit', 'INVENTORY')
check('made', made.ok, made.reason ?? '')
check('it holds the module', made.view?.groups[0]?.members.join() === 'INVENTORY',
  String(made.view?.groups[0]?.members))
check('and the module knows it', made.view?.modules
  .find(m => m.tag === 'INVENTORY')?.groupId === made.view?.groups[0]?.id)

const groupId = made.view!.groups[0].id

console.log('\n── moving modules ──')
const moved = await groups.assignDisplayModule('ABILITIES', groupId)
check('a second module joins', moved.ok
  && moved.view?.groups[0]?.members.length === 2,
  String(moved.view?.groups[0]?.members))

// A module belongs to exactly one group, and the editor has to enforce that
// rather than leaving normalize to pick a winner silently.
const second = await groups.addDisplayGroup('Body', 'ABILITIES')
check('claiming it for another group moves it', second.ok, second.reason ?? '')
const owners = (second.view?.groups ?? []).filter(g => g.members.includes('ABILITIES'))
check('it is in exactly one group', owners.length === 1,
  `${owners.length} group(s) claim it`)
check('and its old group kept its other member',
  second.view?.groups.find(g => g.id === groupId)?.members.join() === 'INVENTORY')

console.log('\n── emptying a group removes it ──')
// `normalizeDisplayGroups` drops memberless groups, so leaving a row that
// vanishes on reload would be worse than removing it now.
const bodyId = second.view!.groups.find(g => g.members.includes('ABILITIES'))!.id
const emptied = await groups.assignDisplayModule('ABILITIES', null)
check('the group went with its last member',
  !emptied.view?.groups.some(g => g.id === bodyId),
  (emptied.view?.groups ?? []).map(g => g.name).join(', '))
check('and the module is on its own again',
  emptied.view?.modules.find(m => m.tag === 'ABILITIES')?.groupId === null)

console.log('\n── renaming ──')
check('a nameless rename is refused', !(await groups.renameDisplayGroup(groupId, ' ')).ok)
const renamed = await groups.renameDisplayGroup(groupId, 'Carried', '🎒')
check('renamed', renamed.ok && renamed.view?.groups[0]?.name === 'Carried',
  String(renamed.view?.groups[0]?.name))
check('the icon came with it', renamed.view?.groups[0]?.icon === '🎒')
check('renaming one that is gone is refused',
  !(await groups.renameDisplayGroup('nope', 'x')).ok)

console.log('\n── the switches ──')
check('grouping starts off', !(await groups.readDisplayGroups()).enabled)
check('and can be turned on', (await groups.setDisplayGroupsEnabled(true)).enabled)
check('gaps can be turned on', (await groups.setDisplayGroupsShowGaps(true)).showGaps)
const off = await groups.setDisplayGroupEnabled(groupId, false)
check('a single group can be left unfolded',
  off.groups.find(g => g.id === groupId)?.enabled === false)

console.log('\n── what the renderer sees ──')
// The renderer has honoured these since the panel landed. This is the check
// that the editor writes the shape it actually reads.
const engineGroups = await import('../src/engine/src/features/display-groups.js') as any
const plan = engineGroups.buildDisplayGroupRenderPlan(
  ['CHARACTER', 'INVENTORY', 'XP'],
  (await groups.readDisplayGroups()).groups,
  true,
)
check('the render plan is built from the stored groups',
  Array.isArray(plan) && plan.length > 0, JSON.stringify(plan).slice(0, 90))

await groups.setDisplayGroupEnabled(groupId, true)
const folded = engineGroups.buildDisplayGroupRenderPlan(
  ['CHARACTER', 'INVENTORY', 'XP'],
  (await groups.readDisplayGroups()).groups,
  true,
)
check('an enabled group becomes one host card, not two',
  folded.some((item: any) => item.kind === 'group'),
  JSON.stringify(folded).slice(0, 110))

console.log('\n── deleting ──')
const deleted = await groups.deleteDisplayGroup(groupId)
check('gone', !deleted.groups.some(g => g.id === groupId))
check('its module renders on its own again',
  deleted.modules.find(m => m.tag === 'INVENTORY')?.groupId === null)

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'groups:read' })
await wait()
check('the editor is sent the state',
  !!state.toFrontend.find(m => (m as any).type === 'groups:state'))

state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'groups:add', name: 'Survival', member: 'XP' })
await wait()
const added = state.toFrontend.find(m => (m as any).type === 'groups:state') as any
check('adding through the panel works',
  (added?.groups ?? []).some((g: any) => g.name === 'Survival'),
  (added?.groups ?? []).map((g: any) => g.name).join(', '))
check('and the panel is repainted',
  state.toFrontend.some(m => (m as any).type === 'panel:render'),
  'grouping is exactly what the panel draws')

state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'groups:add', name: '', member: 'TIME' })
await wait()
const refused = state.toFrontend.find(m => (m as any).type === 'groups:state') as any
check('a refusal comes back with a reason', !!refused?.reason, String(refused?.reason))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'prompt defaults test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
