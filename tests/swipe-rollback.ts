/**
 * swipe-rollback.ts — a regenerated reply is tracked from the state before it.
 *
 *   bun tests/swipe-rollback.ts
 *
 * Upstream stamps each tracked reply with the memo before and after it, keyed
 * by swipe, and on a swipe or regenerate puts the memo back. Two things broke
 * that in the port, either of them enough on its own:
 *
 *   - the port's state pass never wrote the snapshot (upstream does it in
 *     `runStateModelPass`, which the port replaced)
 *   - the chat mirror never saved anything the engine kept on a message, so
 *     even a snapshot would have been lost at the next re-read — and the swipe
 *     itself arrives as one
 *
 * The result: regenerate a hit for 14 damage into one for 10, and the tracker
 * was asked to apply the 10 to a sheet that already had the 14.
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const host = (id: string, idx: number, user: boolean, text: string): Record<string, any> => ({
  id, chat_id: 'chat-1', index_in_chat: idx,
  is_user: user, role: user ? 'user' : 'assistant',
  name: user ? 'You' : 'Narrator',
  content: text, send_date: 0, swipe_id: 0, swipes: [text], swipe_dates: [0],
  // Another extension's data on the same message: it must survive our writes.
  extra: user ? {} : { spindle_metadata: { other_extension: { pinned: true } } },
  parent_message_id: null, branch_id: null, created_at: 0,
})
const FIRST = 'The wolf bites deep. You take 14 damage.'
const SECOND = 'The wolf grazes you. You take 10 damage.'
state.messages.set('chat-1', [
  host('m1', 0, true, 'I fight the wolf.'),
  host('m2', 1, false, FIRST),
] as never)
const reply = (): Record<string, any> => (state.messages.get('chat-1') as any[])[1]

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await wait(700)
const { chatMirror } = await import('../src/compat/chat-mirror')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
for (let i = 0; i < 200 && chatMirror.getChatId() !== 'chat-1'; i++) await wait(5)
await wait(400)
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
settings.currentMemo = '[CHARACTER]\nName: Kestrel\nHP: 34/34\n[/CHARACTER]'
settings.stateTrackerRunEvery = 1
const hp = (): string => String(settings.currentMemo).match(/HP: [^\n]*/)?.[0] ?? '(none)'
const extractorPrompts = (): string[] => (state.generations as any[])
  .filter(entry => /State Extractor/.test(String(entry?.messages?.[0]?.content ?? '')))
  .map(entry => (entry.messages ?? []).map((m: any) => m.content).join('\n'))
const turn = async (generationType: string, response: string): Promise<void> => {
  state.generationResponse = response
  await emitHostEvent(state, 'GENERATION_STARTED', { chatId: 'chat-1', generationType })
  await emitHostEvent(state, 'GENERATION_ENDED', { chatId: 'chat-1', messageId: 'm2', generationType })
  await wait(900)
}
const intercept = (generationType: string): Promise<unknown> => state.interceptors[0].handler(
  [{ role: 'user', content: 'I fight the wolf.' }] as never,
  { chatId: 'chat-1', userId: state.userId, generationType } as never,
)

console.log('── the first reply ──')
await turn('normal', '[CHARACTER]\nName: Kestrel\nHP: 20/34\n[/CHARACTER]')
check('is tracked', hp() === 'HP: 20/34', hp())
const saved = reply().extra?.spindle_metadata ?? {}
check('the memo before it is saved with the reply',
  /HP: 34\/34/.test(String(saved.multihog_dnd?.rpgMemoRollback?.[0] ?? '')),
  JSON.stringify(saved.multihog_dnd ?? {}).slice(0, 100))
check('without disturbing another extension\'s data on the message',
  saved.other_extension?.pinned === true, JSON.stringify(saved).slice(0, 100))

console.log('\n── a restart later, the reply is regenerated ──')
await chatMirror.refresh()
// The host stages a new, empty swipe and announces it, then asks for the prompt.
reply().swipes.push('')
reply().swipe_dates.push(0)
reply().swipe_id = 1
reply().content = ''
await emitHostEvent(state, 'MESSAGE_SWIPED', { chatId: 'chat-1', message: reply(), action: 'added', swipeId: 1 })
await intercept('swipe')
check('the memo goes back to before the replaced reply', hp() === 'HP: 34/34', hp())
// The new reply streams in and is saved; then the turn ends.
reply().content = SECOND
reply().swipes[1] = SECOND
await emitHostEvent(state, 'MESSAGE_EDITED', { chatId: 'chat-1', message: reply() })
const before = extractorPrompts().length
await turn('swipe', '[CHARACTER]\nName: Kestrel\nHP: 24/34\n[/CHARACTER]')
const prompt = extractorPrompts()[before] ?? ''
check('so the new reply is tracked from 34/34', /HP: 34\/34/.test(prompt) && !/HP: 20\/34/.test(prompt),
  (prompt.match(/HP: [^\n]*/g) ?? []).join(', '))
check('not stacked on the reply it replaced', hp() === 'HP: 24/34', hp())

console.log('\n── swiping back to the first reply ──')
reply().swipe_id = 0
reply().content = FIRST
await emitHostEvent(state, 'MESSAGE_SWIPED', { chatId: 'chat-1', message: reply(), action: 'navigated', swipeId: 0, previousSwipeId: 1 })
await wait(300)
await intercept('normal')
check('restores the state that reply produced', hp() === 'HP: 20/34', hp())

console.log('\n── a marker not yet saved ──')
const mirrored = chatMirror.messages.find(m => m._lvId === 'm2')!
mirrored.extra.rpgRouterRunId = 'run-42'
chatMirror.markDirty()
// An older copy of the message arrives before the debounced save runs.
const stale = JSON.parse(JSON.stringify(reply()))
delete stale.extra.spindle_metadata?.multihog_dnd?.rpgRouterRunId
await emitHostEvent(state, 'MESSAGE_EDITED', { chatId: 'chat-1', message: stale })
check('survives an older copy of the message arriving', chatMirror.messages.find(m => m._lvId === 'm2')?.extra.rpgRouterRunId === 'run-42')
await chatMirror.flush()
check('and is still saved afterwards', reply().extra?.spindle_metadata?.multihog_dnd?.rpgRouterRunId === 'run-42',
  JSON.stringify(reply().extra?.spindle_metadata?.multihog_dnd ?? {}).slice(0, 80))

console.log('\n── leaving before the save runs ──')
state.messages.set('chat-2', [host('x1', 0, true, 'Elsewhere.')].map(m => ({ ...m, chat_id: 'chat-2' })) as never)
chatMirror.messages.find(m => m._lvId === 'm2')!.extra.rpgMapUpdaterRanForSwipe = 'swipe-0'
chatMirror.markDirty()
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-2' })
for (let i = 0; i < 200 && chatMirror.getChatId() !== 'chat-2'; i++) await wait(5)
await wait(900)
check('a marker set just before switching chats is still saved',
  reply().extra?.spindle_metadata?.multihog_dnd?.rpgMapUpdaterRanForSwipe === 'swipe-0',
  JSON.stringify(reply().extra?.spindle_metadata?.multihog_dnd?.rpgMapUpdaterRanForSwipe))
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
for (let i = 0; i < 200 && chatMirror.getChatId() !== 'chat-1'; i++) await wait(5)
await wait(400)
chatMirror.messages.find(m => m._lvId === 'm2')!.extra.rpgMapEvolutionRanForSwipe = 'swipe-0'
chatMirror.markDirty()
await chatMirror.refresh()
check('and so is one set just before the chat is re-read',
  chatMirror.messages.find(m => m._lvId === 'm2')?.extra.rpgMapEvolutionRanForSwipe === 'swipe-0'
  && reply().extra?.spindle_metadata?.multihog_dnd?.rpgMapEvolutionRanForSwipe === 'swipe-0')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'swipe rollback test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
