/**
 * cyoa-history.ts — old choice menus must not ride along in the prompt forever.
 *
 *   bun tests/cyoa-history.ts
 *
 * In CYOA mode every narrator turn ends with a `<choices>` block, and they stay
 * in the chat for good — correctly, since they are the transcript. What is not
 * correct is sending all of them: by turn thirty the model re-reads two dozen
 * dead menus every turn and takes the oldest as formatting examples.
 *
 * The four newest survive, deliberately: they are the fresh examples. So the
 * assertions here are about *which* blocks are kept, not merely that something
 * was removed — a trimmer that kept the four oldest would pass a size check and
 * fail the campaign.
 *
 * The other half is what must NOT be touched. The CYOA instruction block the
 * engine injects carries worked `<choices>` examples of its own, and it is
 * prepended to the user message. Eating those would delete the very
 * instructions asking for choices.
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

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
settings.enabled = true
settings.syspromptModules = { ...(settings.syspromptModules ?? {}), CYOA_mode: true }

const { stripSupersededChoices } = await import('../src/tracker/cyoa-history')

/** A narrator turn ending in a numbered choice menu. */
const turn = (n: number): { role: string; content: string } => ({
  role: 'assistant',
  content: `The corridor turns ${n}.\n<choices>\n<button>1. Go on (turn ${n})</button>\n</choices>`,
})

const conversation = (count: number): Array<{ role: string; content: string }> => {
  const out: Array<{ role: string; content: string }> = []
  for (let n = 1; n <= count; n++) {
    out.push({ role: 'user', content: `I pick something on turn ${n}.` })
    out.push(turn(n))
  }
  return out
}

const blocksIn = (messages: Array<{ content: string }>): number =>
  messages.reduce((sum, m) =>
    sum + (String(m.content).match(/<choices\b[^>]*>[\s\S]*?<\/choices\s*>/gi)?.length ?? 0), 0)

console.log('── a long campaign ──')
const long = conversation(30)
check('thirty turns carry thirty menus', blocksIn(long) === 30, String(blocksIn(long)))

const trimmed = await stripSupersededChoices(long as never) as Array<{ content: string }>
check('only four survive', blocksIn(trimmed) === 4, String(blocksIn(trimmed)))

// The point of keeping any at all is that they are recent examples.
const kept = trimmed.map(m => String(m.content)).join('\n')
for (const n of [27, 28, 29, 30]) {
  check(`kept turn ${n}`, kept.includes(`<button>1. Go on (turn ${n})</button>`))
}
check('dropped the oldest', !/\(turn 1\)/.test(kept))
check('dropped turn 26', !/\(turn 26\)/.test(kept))

// Only the block goes; the narration around it is the story.
check('the prose of an old turn is untouched',
  kept.includes('The corridor turns 1.'),
  'trimming the menu must not trim the scene')

console.log('\n── nothing is mutated in place ──')
// The interceptor is handed the host array; a trimmer that edited it would be
// editing whatever the host does with it afterwards.
check('the original array still has all thirty', blocksIn(long) === 30, String(blocksIn(long)))

console.log('\n── short campaigns are left alone ──')
const short = conversation(3)
const shortOut = await stripSupersededChoices(short as never) as Array<{ content: string }>
check('three menus, three kept', blocksIn(shortOut) === 3, String(blocksIn(shortOut)))

console.log('\n── the instruction block is not a casualty ──')
// The engine prepends CYOA instructions, worked examples and all, to the user
// message. Those examples are `<choices>` blocks too.
const { buildCyoaModeBlock } = await import('../src/engine/constants.js') as {
  buildCyoaModeBlock: (config: Record<string, unknown>) => string
}
const instructions = buildCyoaModeBlock({})
const exampleCount = instructions.match(/<choices\b/gi)?.length ?? 0
check('the instructions really do contain example menus', exampleCount >= 2,
  `${exampleCount} — otherwise this test proves nothing`)

const withInstructions = [
  ...conversation(10),
  { role: 'user', content: `${instructions}\n\n### CURRENT USER INPUT\nI open the door.` },
]
const guarded = await stripSupersededChoices(withInstructions as never) as
  Array<{ role: string; content: string }>
const userText = guarded.filter(m => m.role === 'user').map(m => m.content).join('\n')
check('the examples in the instructions survive intact',
  (userText.match(/<choices\b/gi)?.length ?? 0) === exampleCount,
  'they are what teach the model the format')
check('while the old narrator menus are still trimmed',
  blocksIn(guarded.filter(m => m.role === 'assistant')) === 4)

console.log('\n── the switches ──')
settings.cyoaConfig = { ...(settings.cyoaConfig ?? {}), stripOldChoicesFromPrompt: false }
check('trimming can be turned off',
  blocksIn(await stripSupersededChoices(conversation(30) as never) as never) === 30)
settings.cyoaConfig.stripOldChoicesFromPrompt = true

settings.syspromptModules.CYOA_mode = false
check('no trimming when CYOA is off',
  blocksIn(await stripSupersededChoices(conversation(30) as never) as never) === 30,
  'nothing is producing choices, so nothing should be rewritten')
settings.syspromptModules.CYOA_mode = true

// Upstream is explicit that powering the framework down must not leave stale
// menus steering the model, so this one is deliberately not gated on `enabled`.
settings.enabled = false
check('powering the framework down still trims',
  blocksIn(await stripSupersededChoices(conversation(30) as never) as never) === 4,
  'leftover menus must not keep asking the model for choices')
settings.enabled = true

console.log('\n── through the interceptor ──')
const intercepted = await state.interceptors[0].handler(
  conversation(12) as never,
  { chatId: 'chat-1', userId: 'user-1', generationType: 'normal' } as never,
) as Array<{ role: string; content: string }>

const narratorMenus = blocksIn(intercepted.filter(m => m.role === 'assistant'))
check('the outgoing prompt carries four narrator menus, not twelve',
  narratorMenus === 4, String(narratorMenus))
const wholePrompt = intercepted.map(m => m.content).join('\n')
check('the four are the newest',
  /\(turn 12\)/.test(wholePrompt) && !/\(turn 1\)/.test(wholePrompt))
// And the engine really did inject its instructions into this same prompt, so
// the pass above is stepping around live examples rather than an empty case.
check('the injected CYOA instructions came through with their examples',
  intercepted.some(m => m.role === 'user' && /<CYOA_mode>/.test(m.content)
    && /<choices\b/.test(m.content)))
check('and the conversation is otherwise intact',
  intercepted.some(m => /I pick something on turn 12/.test(m.content)))

console.log('\n── it never costs a turn ──')
const broken = [{ role: 'assistant', get content(): string { throw new Error('boom') } }]
let survived = true
try { await stripSupersededChoices(broken as never) } catch { survived = false }
check('a failure inside trimming does not throw', survived,
  'an economy must never be able to lose a generation')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 110)}`)

console.log(`\n${failures === 0 ? 'cyoa-history test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
