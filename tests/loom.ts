/**
 * loom.ts — Lumiverse's Loom summary, where the campaign can use it.
 *
 *   bun tests/loom.ts
 *
 * Loom keeps a running summary in the chat's metadata. The port now hands it
 * to the narrator when older messages have been cut (and the preset does not
 * already include it), to the passes that need the story so far, and to the
 * panel. Each of those is checked, along with what must *not* happen: the
 * summary sent twice, sent while the whole chat still fits, or handed to the
 * State Tracker, which would re-apply events already in the memo.
 */

import { readFileSync } from 'node:fs'
import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const LINES = [
  'I wake in a cold cell beneath the keep, wrists raw from the irons.',
  'A guard named Hollis slides a bowl of grey stew under the bars.',
  'I ask Hollis who ordered my arrest and why nobody will say.',
  'He glances at the stairs, then whispers that the Baron wants me gone.',
  'I offer him my signet ring if he leaves the door unlatched tonight.',
  'He pockets the ring. At midnight the lock clicks open on its own.',
  'I creep up the stairs toward the courtyard and the stables beyond.',
  'Torchlight sweeps the yard; two sentries argue about dice by the gate.',
  'I slip behind the hay carts and wait for the argument to come to blows.',
  'A shout, a scuffle, and the gate stands unguarded for a heartbeat.',
]
state.messages.set('chat-1', LINES.map((text, i) => ({
  id: `m${i}`, chat_id: 'chat-1', index_in_chat: i, is_user: i % 2 === 0,
  role: i % 2 === 0 ? 'user' : 'assistant', name: i % 2 === 0 ? 'You' : 'Narrator',
  content: text, send_date: 0, swipe_id: 0, swipes: [text], swipe_dates: [0],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})) as never)
const SUMMARY = 'The hero was imprisoned by the Baron, bribed the guard Hollis with a signet ring, and escaped the cell at midnight.'
state.chatMetadata.set('chat-1', { loom_summary: SUMMARY })

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait(900)
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

type Msg = { role: string; content: string }
const preset: Msg[] = [{ role: 'system', content: 'You are the narrator of a dark fantasy story.' }]
const history = (from: number): Msg[] => LINES.slice(from).map((text, i) => ({
  role: (from + i) % 2 === 0 ? 'user' : 'assistant', content: text,
}))
const intercept = async (prompt: Msg[]): Promise<Msg[]> => await state.interceptors[0].handler(
  prompt as never, { chatId: 'chat-1', userId: state.userId, generationType: 'normal' } as never,
) as Msg[]
const storyIn = (out: Msg[]): number => out.filter(m => /<story_so_far>/.test(m.content)).length

console.log('── the narrator ──')
let out = await intercept([...preset, ...history(0)])
check('while the whole chat fits, the summary is not sent', storyIn(out) === 0)
out = await intercept([...preset, ...history(6)])
check('when older messages are cut, it is', storyIn(out) === 1)
const at = out.findIndex(m => /<story_so_far>/.test(m.content))
check('just before the conversation picks up',
  at > 0 && out.slice(0, at).every(m => m.role === 'system') && out[at + 1]?.role !== 'system',
  out.map(m => m.role[0]).join(''))
check('with the summary in it', out[at]?.content.includes(SUMMARY))
out = await intercept([{ role: 'system', content: `Story so far: ${SUMMARY}` }, ...history(6)])
check('never twice — not when the preset already includes it', storyIn(out) === 0)
settings.loomSummaryMode = 'always'
out = await intercept([...preset, ...history(0)])
check('"Always" sends it even with the whole chat there', storyIn(out) === 1)
settings.loomSummaryMode = 'off'
out = await intercept([...preset, ...history(6)])
check('"Never" never does', storyIn(out) === 0)
settings.loomSummaryMode = 'auto'

console.log('\n── the panel ──')
const story = (): any => state.toFrontend.filter(m => (m as any).type === 'story:state').at(-1)
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'panel:refresh', viewChatId: 'chat-1' })
await wait(300)
check('shows the story so far', story()?.summary === SUMMARY, JSON.stringify(story())?.slice(0, 80))
const NEWER = `${SUMMARY} Outside the walls, the hero stole a horse and rode north.`
state.toFrontend.length = 0
await emitHostEvent(state, 'CHAT_CHANGED', {
  chat: { id: 'chat-1', metadata: { loom_summary: NEWER } }, changedFields: ['metadata'],
})
await wait(300)
check('and updates the moment Loom saves a new one', story()?.summary === NEWER)
out = await intercept([...preset, ...history(6)])
check('which the narrator gets from then on', out.some(m => m.content.includes('stole a horse')))
// A run finishing: whatever was known is dropped and re-read from the host.
state.chatMetadata.set('chat-1', { loom_summary: `${NEWER} A storm broke.` })
state.toFrontend.length = 0
await emitHostEvent(state, 'SUMMARIZATION_COMPLETED', { chatId: 'chat-1', generationId: 'g1' })
await wait(300)
check('a finished Loom run is picked up too', /A storm broke/.test(String(story()?.summary)))

console.log('\n── the background passes ──')
const { ConnectionManagerRequestService } = await import('../src/compat/llm')
const sent = async (system: string, user: string): Promise<string> => {
  await ConnectionManagerRequestService.sendRequest('conn-1', [
    { role: 'system', content: system }, { role: 'user', content: user },
  ] as never)
  const request = state.generations.at(-1) as { messages?: Msg[] }
  return (request?.messages ?? []).map(m => m.content).join('\n')
}
const agent = await sent('You maintain the lorebook.',
  '## BUDGET STATUS\n3/12 used\n\n## NEWLY ACTIVATED THIS TURN\n(none)\n\n## NARRATIVE\nThe gate stands open.\n\n## INSTRUCTION\nDecide.')
check('the Lorebook Agent gets the story so far, ahead of the recent narrative',
  /## STORY SO FAR[^\n]*\n[^\n]*storm broke[\s\S]*## NARRATIVE\n/.test(agent), agent.slice(0, 160))
const world = await sent('You advance the world.',
  '## DESIGNATED LOCATIONS\n- Khelt\n\n## RECENT NARRATIVE (Current Scene Context)\nThe gate.\n\nWrite the World Progression report for **Dawn**.')
check('so does World Progression', /## STORY SO FAR[\s\S]*## RECENT NARRATIVE \(Current Scene Context\)/.test(world))
const companion = await sent('You are the adventure companion.\n\n## STATE MEMO (State Tracker)\nHP 9/10\n\n## NARRATIVE HISTORY (Last 4 of 4 requested messages)\nThe gate.', 'What now?')
check('and the Companion', /## STORY SO FAR[\s\S]*## NARRATIVE HISTORY \(/.test(companion))
const whole = await sent('You are the adventure companion.\n\n## NARRATIVE HISTORY (All 10 messages)\nThe gate.', 'Recap?')
check('whichever lookback it uses', /## STORY SO FAR/.test(whole))

// The State Tracker writes a `## NARRATIVE HISTORY (…)` heading too. Its real
// prompts — not a stand-in — must go out untouched.
settings.currentMemo = '[CHARACTER]\nName: Kestrel\nHP: 9/10\n[/CHARACTER]'
state.generationResponse = '[CHARACTER]\nName: Kestrel\nHP: 8/10\n[/CHARACTER]'
const extractor = (): string => (state.generations as any[])
  .filter(entry => /State Extractor/.test(String(entry?.messages?.[0]?.content ?? '')))
  .map(entry => (entry.messages ?? []).map((m: any) => m.content).join('\n')).at(-1) ?? ''
const { runStatePass } = await import('../src/tracker/state-pass')
await runStatePass()
check('but not the State Tracker, which would re-apply what the memo already has',
  extractor() !== '' && /## NARRATIVE HISTORY/.test(extractor()) && !/STORY SO FAR/.test(extractor()),
  extractor().slice(0, 80))
const before = state.generations.length
const { sendDirectPrompt } = await import('../src/tracker/direct-prompt') as any
if (typeof sendDirectPrompt === 'function') await sendDirectPrompt('Kestrel drinks a potion.')
const asked = (state.generations.slice(before) as any[]).map(e => (e.messages ?? []).map((m: any) => m.content).join('\n')).join('\n')
check('nor the tracker\u2019s "ask" edits', typeof sendDirectPrompt === 'function' && asked !== '' && !/STORY SO FAR/.test(asked),
  typeof sendDirectPrompt === 'function' ? asked.slice(0, 60) : 'no sendDirectPrompt export')
settings.loomSummaryForPasses = false
const off = await sent('You maintain the lorebook.', '## BUDGET STATUS\nx\n\n## NARRATIVE\ny\n\n## INSTRUCTION\nz')
check('and nobody when that is switched off', !/STORY SO FAR/.test(off))
settings.loomSummaryForPasses = true

console.log('\n── the engine still writes the headings these rely on ──')
const router = readFileSync(new URL('../src/engine/router.js', import.meta.url), 'utf8')
const companionSrc = readFileSync(new URL('../src/engine/adventure-companion.js', import.meta.url), 'utf8')
// Both of the agent's modes: the heading, straight into the chat it reads.
const narrativeHeadings = router.split('## NARRATIVE\\n${recentChatString}').length - 1
const budgetHeadings = router.split('`## BUDGET STATUS\\n').length - 1
check('the agent\'s ## BUDGET STATUS and ## NARRATIVE, in both modes', narrativeHeadings >= 2 && budgetHeadings >= 2,
  `${budgetHeadings} / ${narrativeHeadings}`)
check('World Progression\'s', router.includes('## RECENT NARRATIVE (Current Scene Context)') && router.includes('Write the World Progression report'))
check('the Companion\'s', companionSrc.includes('## NARRATIVE HISTORY ('))

console.log('\n── a chat without a summary ──')
state.chatMetadata.set('chat-1', {})
await emitHostEvent(state, 'CHAT_CHANGED', { chat: { id: 'chat-1', metadata: {} }, changedFields: ['metadata'] })
await wait(300)
out = await intercept([...preset, ...history(6)])
check('adds nothing anywhere', storyIn(out) === 0 && story()?.summary === '')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'loom test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
