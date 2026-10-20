/**
 * message-events.ts — the host events upstream reacts to and the port did not.
 *
 *   bun tests/message-events.ts
 *
 * Upstream subscribes in `index.js`, which the port replaces. The port bridged
 * the host's events into the engine's `eventSource` shim — and nothing ever
 * subscribed to the shim, so every one of these was a no-op:
 *
 *   - a message saved in another chat (a background reply finishing) was
 *     appended to the *open* chat's mirror, as if it were this story's
 *   - a stopped generation: upstream still runs the post-turn pipeline on the
 *     partial reply it keeps
 *   - a swipe or an edit: upstream rolls back the relationship changes and the
 *     map and Lorebook Agent passes that belonged to the replaced reply
 *   - opening a chat: upstream catches up on a Map Architect fence the last
 *     reply asked for and nothing processed
 *   - a sent message: upstream lets the map updater fill a building the player
 *     says they are entering, before the narrator's prompt is built
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const host = (chatId: string, id: string, idx: number, user: boolean, text: string, extra: Record<string, unknown> = {}, swipeId = 0, swipes = [text]): Record<string, any> => ({
  id, chat_id: chatId, index_in_chat: idx,
  is_user: user, role: user ? 'user' : 'assistant',
  name: user ? 'You' : 'Narrator',
  content: text, send_date: 0, swipe_id: swipeId, swipes, swipe_dates: swipes.map(() => 0),
  extra, parent_message_id: null, branch_id: null, created_at: 0,
})
state.messages.set('chat-1', [
  host('chat-1', 'm1', 0, true, 'I share my rations with Tiktik.'),
  host('chat-1', 'm2', 1, false, 'Tiktik grins and eats.'),
] as never)
state.messages.set('chat-2', [host('chat-2', 'n1', 0, true, 'Hello.')] as never)
state.generationResponse = '[CHARACTER]\nName: Kestrel\nHP: 9/10\n[/CHARACTER]'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await wait(700)
const { chatMirror } = await import('../src/compat/chat-mirror')
const go = async (id: string): Promise<void> => {
  await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: id })
  for (let i = 0; i < 200 && chatMirror.getChatId() !== id; i++) await wait(5)
  await wait(500)
}
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const { getSchedulerEventLog, clearSchedulerEventLog } = await import('../src/engine/swipe-scheduler-debug.js') as {
  getSchedulerEventLog: () => Array<Record<string, any>>
  clearSchedulerEventLog: () => void
}
const events = (type: string): Array<Record<string, any>> => getSchedulerEventLog().filter(e => e.type === type)
const extractorCalls = (): number => (state.generations as unknown[]).filter(entry =>
  /State Extractor/.test(String((entry as any)?.messages?.[0]?.content ?? ''))).length

await go('chat-1')
settings.currentMemo = '[CHARACTER]\nName: Kestrel\nHP: 10/10\n[/CHARACTER]'

console.log('── a message saved in another chat ──')
const length = chatMirror.messages.length
await emitHostEvent(state, 'MESSAGE_EDITED', {
  chatId: 'chat-2', message: host('chat-2', 'n2', 1, false, 'Meanwhile, in another story entirely.'),
})
await emitHostEvent(state, 'MESSAGE_SENT', {
  chatId: 'chat-2', message: host('chat-2', 'n3', 2, true, 'And another line.'),
})
check('stays out of the open chat\'s mirror', chatMirror.messages.length === length
  && !chatMirror.messages.some(m => /another story/.test(String(m.mes))),
  `${chatMirror.messages.length - length} message(s) leaked in`)
await emitHostEvent(state, 'MESSAGE_SENT', {
  chatId: 'chat-1', message: host('chat-1', 'm3', 2, true, 'I look around.'),
})
check('while the open chat\'s own messages still arrive', chatMirror.messages.at(-1)?.mes === 'I look around.')

console.log('\n── a swipe ──')
// The last reply had a relationship change applied on swipe 0 (+5 friendship),
// recorded the way the engine records it. Swiping to another reply must take
// that change back.
settings.npcRelationshipBars = true
settings.npcRelationshipUpdateMode = 'state_tracker'
settings.npcRelationshipValues = { tiktik: { friendship: 15, affection: 0 } }
const swiped = host('chat-1', 'm4', 3, false, 'Tiktik shrugs.', {
  rpgActiveSwipe: 0,
  rpgProcessedTags: { 0: [] },
  rpgRollbackData: { 0: [{ npcId: 'tiktik', field: 'friendship', actualAppliedDelta: 5, expectedValue: 15, logTimestamp: 1 }] },
}, 1, ['Tiktik grins and eats.', 'Tiktik shrugs.'])
state.messages.get('chat-1')!.push(swiped as never)
clearSchedulerEventLog()
await emitHostEvent(state, 'MESSAGE_SWIPED', { chatId: 'chat-1', message: swiped, action: 'navigated', swipeId: 1 })
await wait(600)
check('rolls back the replaced reply\'s relationship change', settings.npcRelationshipValues.tiktik.friendship === 10,
  `friendship ${settings.npcRelationshipValues.tiktik.friendship}`)
check('through upstream\'s own swipe handler', events('relationship_swipe_change').length === 1)

console.log('\n── an edit that changes nothing a reader would see ──')
clearSchedulerEventLog()
// The port's own writes to message extras come back as MESSAGE_EDITED.
const echo = { ...swiped, extra: { ...swiped.extra, rpgActiveSwipe: 1, someMarker: true } }
await emitHostEvent(state, 'MESSAGE_EDITED', { chatId: 'chat-1', message: echo })
await wait(400)
check('is not treated as a swipe or an edit', events('relationship_swipe_change').length === 0
  && events('rel_tags_skipped').length === 0, JSON.stringify(getSchedulerEventLog().map(e => e.type)))

console.log('\n── a stopped generation ──')
settings.stateTrackerRunEvery = 1
let calls = extractorCalls()
await emitHostEvent(state, 'GENERATION_STARTED', { chatId: 'chat-1', generationType: 'normal' })
await emitHostEvent(state, 'GENERATION_STOPPED', { chatId: 'chat-1', content: 'Tiktik shrugs, then—' })
await wait(900)
check('still tracks the partial reply it kept, as upstream does', extractorCalls() === calls + 1,
  `${extractorCalls() - calls} pass(es)`)
calls = extractorCalls()
await emitHostEvent(state, 'GENERATION_STARTED', { chatId: 'chat-1', generationType: 'normal' })
await emitHostEvent(state, 'GENERATION_STOPPED', { chatId: 'chat-1', content: '' })
await wait(700)
check('but not one stopped before it wrote anything', extractorCalls() === calls,
  `${extractorCalls() - calls} pass(es)`)
await go('chat-2')
state.toFrontend.length = 0
await emitHostEvent(state, 'GENERATION_STOPPED', { chatId: 'chat-1', content: 'Tiktik shrugs, then—' })
await wait(500)
check('one stopped in a chat you have left waits for your return',
  state.toFrontend.some(m => (m as any).type === 'toast' && /reply finished in/i.test((m as any).message))
  && chatMirror.getChatId() === 'chat-2')

console.log('\n── opening a chat ──')
settings.mapArchitectOpener = 'text'
settings.enabled = true
const { LOCATION_MAPPING_SECTION_TAG } = await import('../src/engine/src/state/section-enabled.js') as {
  LOCATION_MAPPING_SECTION_TAG: string
}
// The real switch: `syspromptModules` — persistent maps are off for a new install.
settings.syspromptModules = { ...(settings.syspromptModules ?? {}), [LOCATION_MAPPING_SECTION_TAG]: true }
clearSchedulerEventLog()
await go('chat-1')
await wait(400)
const opener = getSchedulerEventLog().filter(e => /^map_architect_text_opener_/.test(e.type) && e.source === 'message_received')
check('checks for a Map Architect fence the last reply left unprocessed', opener.length >= 1,
  JSON.stringify(getSchedulerEventLog().map(e => e.type)).slice(0, 160))

console.log('\n── sending a message ──')
const intent = async (): Promise<Record<string, any> | null> =>
  (await import('../src/tracker/map-intent')).lastMapIntent as Record<string, any> | null
settings.mapUpdaterEnabled = true
// Modules are kept per chat, and switching into this one restored its own set.
settings.syspromptModules = { ...(settings.syspromptModules ?? {}), [LOCATION_MAPPING_SECTION_TAG]: true }
const sent = host('chat-1', 'm5', 4, true, 'I step into the smithy.')
state.messages.get('chat-1')!.push(sent as never)
await emitHostEvent(state, 'MESSAGE_SENT', { chatId: 'chat-1', message: sent })
const intercept = (generationType: string, isDryRun = false): Promise<unknown> => state.interceptors[0].handler(
  [{ role: 'user', content: 'I step into the smithy.' }] as never,
  { chatId: 'chat-1', userId: state.userId, generationType, isDryRun } as never,
)
await intercept('normal')
check('the map updater sees it before the narrator\'s prompt is built',
  (await intent())?.result?.skipped === 'no_active_map',
  JSON.stringify(await intent()))
await intercept('swipe')
check('but not on a swipe, which sends nothing new', (await intent())?.reason === 'not_a_new_message')
await intercept('normal', true)
check('nor for a prompt preview', (await intent())?.reason === 'dry_run')
settings.mapUpdaterEnabled = false
await intercept('normal')
check('and not at all with the map updater off', (await intent())?.reason === 'maps_off')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'message events test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
