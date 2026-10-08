/**
 * full-audit.ts — rebuilding the sheet from the whole campaign.
 *
 *   bun tests/full-audit.ts
 *
 * The incremental pass only ever reads the last turn, so whatever it missed
 * stays missed forever. The audit is the repair, and it is a different shape of
 * operation: it walks the entire chat in context-sized chunks, one model call
 * each, committing after every one so the next chunk builds on the last.
 *
 * That accumulation is the thing worth testing. A chunked audit where each
 * chunk starts from the same memo is not an audit — it is the last chunk's
 * opinion, and it would pass a naive "did the memo change" check.
 *
 * This file also covers the prompt-assembly fixes the audit sits on top of:
 * `fullReviewStateMode`, the DD/MM date examples, and the memo-history depth
 * that `trackerHistoryCount` is supposed to control.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()

const msg = (id: string, idx: number, user: boolean, text: string): Record<string, unknown> => ({
  id, chat_id: 'chat-1', index_in_chat: idx,
  is_user: user, role: user ? 'user' : 'assistant',
  name: user ? 'You' : 'Narrator',
  content: text, send_date: 0, swipe_id: 0, swipes: [text], swipe_dates: [0],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})

// A campaign long enough to need splitting, with facts spread across it that an
// incremental pass would never revisit.
const history: Array<Record<string, unknown>> = []
history.push(msg('u0', 0, true, 'I take the rope from the quartermaster.'))
history.push(msg('a0', 1, false, `You coil the rope into your pack. ${'The dock creaks. '.repeat(120)}`))
for (let n = 1; n <= 10; n++) {
  history.push(msg(`u${n}`, n * 2, true, `I press on, day ${n}.`))
  history.push(msg(`a${n}`, n * 2 + 1, false,
    `The road unwinds. ${'Grass, stone, and a grey sky. '.repeat(120)}`))
}
history.push(msg('uZ', 99, true, 'I look at my hands.'))
history.push(msg('aZ', 100, false, 'They are steady. You are still carrying the rope.'))
state.messages.set('chat-1', history)

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
settings.enabled = true

const { runFullAudit, runStatePass } = await import('../src/tracker/state-pass')

const promptsSince = (from: number): string[] =>
  state.generations.slice(from).map(request =>
    ((request as { messages?: Array<{ content: string }> }).messages ?? [])
      .map(m => m.content).join('\n'))

console.log('── it splits the campaign ──')
settings.currentMemo = '[INVENTORY]\n(empty)\n[/INVENTORY]'
settings.fullAuditMaxTokens = 4000

// Each chunk reports back a different inventory, so the memo can be read
// afterwards to see which chunk actually landed last.
state.generationQueue = [
  '[INVENTORY]\nRope\n[/INVENTORY]',
  '[INVENTORY]\nRope, torch\n[/INVENTORY]',
  '[INVENTORY]\nRope, torch, half a loaf\n[/INVENTORY]',
  '[INVENTORY]\nRope, torch, half a loaf, a grey feather\n[/INVENTORY]',
  '[INVENTORY]\nRope, torch, half a loaf, a grey feather, a knife\n[/INVENTORY]',
]

let mark = state.generations.length
const progress: Array<[number, number]> = []
const audited = await runFullAudit((done, total) => progress.push([done, total]))

check('the audit ran', audited.ran, audited.reason ?? '')
check('it split the chat into several chunks', audited.chunks > 1, `${audited.chunks} chunk(s)`)
check('one model call per chunk',
  state.generations.length - mark === audited.chunks,
  `${state.generations.length - mark} call(s) for ${audited.chunks} chunk(s)`)
check('it reported progress as it went',
  progress.length >= audited.chunks, `${progress.length} update(s)`)

console.log('\n── each chunk builds on the last ──')
// The point of committing per chunk: chunk N is shown what chunk N-1 produced.
// Without that, every chunk would be handed the same starting memo and the
// audit would be worth exactly one call.
const auditPrompts = promptsSince(mark)
check('the first chunk saw the starting memo',
  /## PRIOR MEMO[\s\S]*\(empty\)/.test(auditPrompts[0] ?? ''),
  (auditPrompts[0] ?? '').slice(0, 60))
check('the second chunk saw the first chunk’s result',
  /## PRIOR MEMO[\s\S]*Rope/.test(auditPrompts[1] ?? ''),
  'otherwise the chunks are not accumulating')
check('the last chunk saw everything before it',
  /## PRIOR MEMO[\s\S]*grey feather/.test(auditPrompts.at(-1) ?? ''))

check('the committed memo is the newest reply, not the first',
  String(settings.currentMemo).includes('a knife'),
  String(settings.currentMemo).replace(/\n/g, ' '))

// Only five replies were queued; the rest of the chunks got nothing back. A
// weak or refused chunk halfway through a long campaign must not abandon the
// chunks after it — the audit is the expensive operation, and losing it to one
// bad reply is how a user learns never to press the button again.
check('the run continued past chunks that returned nothing',
  audited.committed === 5 && audited.chunks === 11,
  `${audited.committed} committed of ${audited.chunks}`)
check('and it still finished rather than reporting a stop',
  audited.reason === undefined, String(audited.reason))

console.log('\n── an audit asks a different question ──')
check('it says so in the prompt',
  /Rebuild the State Memo/.test(auditPrompts[0] ?? '')
    && /COMPLETE VERIFIED STATE MEMO/i.test(auditPrompts[0] ?? ''),
  'an incremental pass asks only for what changed')
check('and it names the chunk it is on',
  /NARRATIVE HISTORY \(Chunk 1 of \d+\)/.test(auditPrompts[0] ?? ''))
check('it reads the whole campaign, not the last turn',
  auditPrompts.join('\n').includes('quartermaster'),
  'the rope was picked up in the first message')

console.log('\n── it stops where it is told ──')
const { stopStatePass } = await import('../src/tracker/state-pass')
settings.currentMemo = '[INVENTORY]\n(empty)\n[/INVENTORY]'
state.generationQueue = []
state.generationResponse = '[INVENTORY]\nA lantern\n[/INVENTORY]'
mark = state.generations.length
const stopping = runFullAudit(done => { if (done >= 1) stopStatePass() })
const stopped = await stopping
check('stopping partway is not a failure', stopped.committed >= 1,
  `${stopped.committed} chunk(s) committed`)
check('what it did commit is kept',
  String(settings.currentMemo).includes('A lantern'),
  'an interrupted audit leaves the sheet further along, not broken')
check('it did not silently finish the rest',
  stopped.committed < stopped.chunks || stopped.chunks === 1,
  `${stopped.committed}/${stopped.chunks}`)

console.log('\n── guards ──')
settings.enabled = false
check('a disabled tracker refuses', !(await runFullAudit()).ran)
settings.enabled = true

console.log('\n── full review mode ──')
// This toggle has been in settings since the port began and read by nothing.
settings.fullAuditMaxTokens = 32000
settings.currentMemo = '[INVENTORY]\nRope\n[/INVENTORY]'
state.generationQueue = []
state.generationResponse = '[INVENTORY]\nRope, a knife\n[/INVENTORY]'

settings.fullReviewStateMode = false
mark = state.generations.length
await runStatePass()
const incremental = promptsSince(mark)[0] ?? ''

settings.fullReviewStateMode = true
mark = state.generations.length
await runStatePass()
const fullReview = promptsSince(mark)[0] ?? ''

check('the two modes send different prompts', incremental !== fullReview,
  'the toggle did nothing at all before this')
check('full review asks for the complete memo',
  /COMPLETE, VERIFIED STATE MEMO/i.test(fullReview),
  fullReview.slice(-90).replace(/\n/g, ' '))
check('the incremental mode still asks only for changes',
  /OUTPUT ONLY CHANGED SECTIONS/i.test(incremental))
settings.fullReviewStateMode = false

console.log('\n── date format ──')
// The core prompt teaches the memo format by example. Leaving the examples on
// "Day 3" while the extension renders DD/MM trains the wrong format.
settings.useDdMmYyFormat = true
mark = state.generations.length
await runStatePass()
const dated = promptsSince(mark)[0] ?? ''
settings.useDdMmYyFormat = false
mark = state.generations.length
await runStatePass()
const plain = promptsSince(mark)[0] ?? ''

check('the shipped prompt does use day-numbered examples', /Day\s+\d/.test(plain),
  'otherwise this check proves nothing')
check('picking DD/MM rewrites the examples', !/Day\s+\d/.test(dated) && /\d\d\/\d\d\/\d{4}/.test(dated),
  dated.match(/\d\d\/\d\d\/\d{4}[^\n]*/)?.[0] ?? 'no date example found')

console.log('\n── memo history depth ──')
// `trackerHistoryCount` is how many past memos the model is *shown*, not only
// how many are archived. The port kept the archive and dropped the prompt half.
settings.memoHistory = ['[INVENTORY]\nNothing\n[/INVENTORY]', '[INVENTORY]\nA stick\n[/INVENTORY]']
settings.currentMemo = '[INVENTORY]\nRope\n[/INVENTORY]'

settings.trackerHistoryCount = 1
mark = state.generations.length
await runStatePass()
const shallow = promptsSince(mark)[0] ?? ''

settings.memoHistory = ['[INVENTORY]\nNothing\n[/INVENTORY]', '[INVENTORY]\nA stick\n[/INVENTORY]']
settings.currentMemo = '[INVENTORY]\nRope\n[/INVENTORY]'
settings.trackerHistoryCount = 3
mark = state.generations.length
await runStatePass()
const deep = promptsSince(mark)[0] ?? ''

check('depth 1 sends only the current state',
  shallow.includes('TRACKER STATE 0') && !shallow.includes('TRACKER STATE -1'))
check('depth 3 sends the earlier ones too',
  deep.includes('TRACKER STATE -1') && deep.includes('TRACKER STATE -2'),
  deep.match(/TRACKER STATE -?\d/g)?.join(', ') ?? 'none')
check('and they are in chronological order',
  deep.indexOf('TRACKER STATE -2') < deep.indexOf('TRACKER STATE -1')
    && deep.indexOf('TRACKER STATE -1') < deep.indexOf('TRACKER STATE 0'))

console.log('\n── through the panel ──')
settings.currentMemo = '[INVENTORY]\nRope\n[/INVENTORY]'
settings.fullAuditMaxTokens = 32000
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'tracker:full-audit' })
await wait(600)

const labels = state.toFrontend
  .filter(m => (m as any).type === 'panel:status')
  .map(m => String((m as any).label ?? ''))
check('the panel is told an audit is running',
  labels.some(label => /full audit/i.test(label)), labels.join(' | '))
check('and which chunk it is on',
  labels.some(label => /chunk \d+ of \d+/i.test(label)),
  'a long audit that only said "working" is indistinguishable from a hang')
check('the result names the chunk count',
  state.toFrontend.some(m => (m as any).type === 'panel:result'
    && /chunk/i.test(String((m as any).reason ?? ''))),
  'so "nothing changed" reads as "it looked and found nothing"')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'full audit test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
