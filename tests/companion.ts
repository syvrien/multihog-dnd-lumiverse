/**
 * companion.ts — the Adventure Companion.
 *
 *   bun tests/companion.ts
 *
 * A side conversation with someone who can see the campaign — and act on it.
 * The acting is the part worth pinning: a companion that says it took your turn
 * without taking it is worse than one that cannot act at all.
 *
 * On a connection profile the engine deliberately does not send native tools
 * (`ConnectionManagerRequestService` forwards them unreliably), so the model
 * asks for actions in a text format that `parseCompanionFallbackActions` reads.
 * That is the path this port actually uses, so it is the path under test.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()

const msg = (id: string, chat: string, text: string, user = true): Record<string, unknown> => ({
  id, chat_id: chat, index_in_chat: 0, is_user: user, role: user ? 'user' : 'assistant',
  name: user ? 'You' : 'Narrator', content: text, send_date: 0, swipe_id: 0,
  swipes: [text], swipe_dates: [0], extra: {}, parent_message_id: null,
  branch_id: null, created_at: 0,
})

state.messages.set('chat-1', [
  msg('m1', 'chat-1', 'We push open the crypt door.'),
  msg('m2', 'chat-1', 'Cold air spills out. Something shifts in the dark.', false),
])
state.messages.set('chat-2', [msg('m3', 'chat-2', 'A different campaign entirely.')])

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
settings.currentMemo = '[CHARACTER]\nSyg (Resonator)\nHP: 8/8\n[/CHARACTER]'

const {
  askCompanion, clearCompanionHistory, readCompanionHistory, readCompanionPrefs,
  writeCompanionPrefs,
} = await import('../src/tracker/companion')

console.log('── a plain answer ──')
state.generationResponse = 'You are in a crypt and something is moving. Light a torch.'
const first = await askCompanion('What is happening?')
check('answered', first.ok, first.reason ?? '')
check('gave back the model\'s words', /light a torch/i.test(first.reply ?? ''),
  (first.reply ?? '').slice(0, 50))

const history = await readCompanionHistory()
check('both sides are in the transcript',
  history.length === 2 && history[0].role === 'user' && history[1].role === 'assistant',
  history.map(h => h.role).join(', '))

console.log('\n── what it is allowed to see ──')
await writeCompanionPrefs({ injectMemo: true, injectLore: false, injectMap: false })
state.generations.length = 0
state.generationResponse = 'Noted.'
await askCompanion('And my character?')
const prompt = (state.generations[0] as { messages?: Array<{ content: string }> })
  ?.messages?.map(m => m.content).join('\n') ?? ''
check('the state memo reached the prompt when asked for',
  prompt.includes('Syg (Resonator)'), prompt.length ? 'present' : 'no prompt captured')
check('so did the recent story', prompt.includes('crypt door'))
check('it is told it can take a turn', /PLAYER ACTION CAPABILITY/.test(prompt))

await writeCompanionPrefs({ injectMemo: false })
state.generations.length = 0
await askCompanion('Never mind.')
const without = (state.generations[0] as { messages?: Array<{ content: string }> })
  ?.messages?.map(m => m.content).join('\n') ?? ''
check('and left out when not', !without.includes('Syg (Resonator)'))

console.log('\n── it can take a turn for you ──')
// The action format the engine parses on a profile connection.
const before = state.messages.get('chat-1')!.length
state.generationResponse = 'On it.\n<companion_action type="act_for_user">'
  + 'I light a torch and step inside.</companion_action>'
const acted = await askCompanion('Light a torch and go in.')
await wait()

const after = state.messages.get('chat-1')!.length
check('the turn actually reached the chat', after > before,
  `${before} -> ${after} message(s)`)
const sent = state.messages.get('chat-1')!.at(-1) as { content?: string }
check('and it said what the companion said it would',
  /light a torch/i.test(String(sent?.content)), String(sent?.content).slice(0, 60))
check('the companion reported back', acted.ok, acted.reason ?? '')

console.log('\n── it can drive the tracker ──')
state.generations.length = 0
// Turn one asks for the action; turn two is the summary once the result comes
// back. Repeating the action forever is what the loop's own cap is for.
state.generationQueue = [
  'Fixing that.\n<companion_action type="state_tracker">'
  + 'Syg has 12 HP, not 8.</companion_action>',
  '[CHARACTER]\nSyg (Resonator)\nHP: 12/12\n[/CHARACTER]',
  'Done — your HP now reads 12.',
]
const fixed = await askCompanion('My HP is wrong.')
await wait()
const trackerCall = (state.generations as Array<{ messages?: Array<{ content: string }> }>)
  .some(g => (g.messages ?? []).some(m => /12 HP/.test(m.content)))
check('the instruction reached the state model', trackerCall,
  `${state.generations.length} generation(s)`)
check('the memo was actually corrected',
  String(settings.currentMemo).includes('12/12'),
  String(settings.currentMemo).replace(/\n/g, ' ').slice(0, 40))
check('and it stopped once the work was done',
  fixed.ok && state.generationQueue.length === 0,
  `${state.generationQueue.length} reply/replies unused`)

console.log('\n── the conversation belongs to the chat ──')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-2' })
await wait()
check('a different chat starts empty',
  (await readCompanionHistory()).length === 0,
  `${(await readCompanionHistory()).length} message(s)`)

state.generationResponse = 'Different campaign, different problem.'
await askCompanion('Where am I?')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait()
const back = await readCompanionHistory()
check('the first chat\'s conversation came back',
  back.some(entry => /light a torch/i.test(entry.content)),
  `${back.length} message(s)`)
check('and the other chat\'s did not come with it',
  !back.some(entry => /Different campaign/.test(entry.content)))

// The return trip, which is where this broke. Leaving a chat runs
// `flushAdventureCompanionForChat`, and the engine is explicit that it "must
// run before the live companion is swapped on chat switch" — but the port ran
// it *after* `loadChatState()` had already swapped the arriving chat in. So
// leaving chat 2 wrote chat 1's conversation into chat 2's slot and chat 2's
// own was lost. Going one way and back only exercises the half that worked.
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-2' })
await wait()
const second = await readCompanionHistory()
check('the second chat kept its own conversation',
  second.some(entry => /Different campaign/.test(entry.content)),
  second.map(entry => entry.content.slice(0, 24)).join(' | ') || '(empty)')
check('and did not inherit the first chat\'s',
  !second.some(entry => /light a torch/i.test(entry.content)))
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait()

console.log('\n── clearing ──')
await clearCompanionHistory()
check('gone', (await readCompanionHistory()).length === 0)

console.log('\n── the panel is a view of it ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'companion:read' })
await wait()
const painted = state.toFrontend.find(m => (m as any).type === 'companion:state') as any
check('the panel is sent the transcript and the switches',
  !!painted && Array.isArray(painted.history) && typeof painted.prefs?.injectMemo === 'boolean',
  JSON.stringify(painted?.prefs ?? {}))

console.log('\n── refusals ──')
check('an empty question is refused', !(await askCompanion('   ')).ok)

const prefs = await readCompanionPrefs()
check('preferences round-trip', typeof prefs.lookback === 'number',
  JSON.stringify(prefs))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'companion test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
