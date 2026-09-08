/**
 * card-context.ts — does rolling a character know what campaign it is for?
 *
 *   bun tests/card-context.ts
 *
 * It did not. `buildCharacterGenerationPrompt()` builds a "CHARACTER CARD
 * CONTEXT" block from `ctx.characters?.[ctx.characterId]`, and eight call sites
 * across the creator, the portraits and the narrative hooks read the same pair.
 * Nothing in the port ever called `setActiveCharacter` or `setCharacters`, so
 * the id stayed `null`, the list stayed empty, and every one of those lookups
 * quietly returned `undefined`.
 *
 * Nothing threw. Instant Action just rolled a generic character with no
 * connection to the story on screen, which reads as the model being bland
 * rather than as a wiring fault — the reason this went unnoticed.
 *
 * The second half is about *not overcorrecting*. The card's scenario reaches
 * the generator now, and two things must not follow from that: the story must
 * not be echoed back into the chat as though the user typed it, and a "level 5
 * threat" in a scenario must not decide the player's level.
 */

import { emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'x', send_date: 0, swipe_id: 0, swipes: ['x'],
  swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
}])

// A campaign played against a card with a scenario and an opening scene.
state.characterCards.set('card-1', {
  id: 'card-1',
  name: 'The Rust-Lantern District',
  description: 'A drowned quarter of Khelt where the lamps burn green and the '
    + 'watch does not come after dark.',
  personality: '',
  scenario: 'The canals have started giving back what was thrown into them. '
    + 'A level 5 threat is rumoured to nest beneath the Ash Door.',
  first_mes: 'Rain on green glass. The ferryman will not take you further than '
    + 'the third bridge, and he will not say why.',
})
state.chatCharacter.set('chat-1', 'card-1')

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
settings.enabled = true

console.log('── the card reaches the engine ──')
const ctx = (globalThis as any).SillyTavern.getContext()
check('a card is resolved for the chat', ctx.characters?.length === 1,
  `${ctx.characters?.length} card(s)`)
// SillyTavern's `characterId` is an array index, and `narrative-hooks.js`
// checks `Array.isArray(ctx.characters)` before indexing it.
check('the id is an array index, as the engine expects',
  ctx.characterId === 0, JSON.stringify(ctx.characterId))
check('and it indexes to the card',
  ctx.characters?.[ctx.characterId]?.name === 'The Rust-Lantern District',
  String(ctx.characters?.[ctx.characterId]?.name))

console.log('\n── rolling a character knows the campaign ──')
const creator = await import('../src/engine/character-creator.js') as any
const built = creator.buildCharacterGenerationPrompt({
  genre: 'fantasy', classRaw: 'Fighter', level: 1,
})
check('the card context block is built', built.cardSnippet.length > 0,
  built.cardSnippet.slice(0, 60))
check('and it reaches the prompt',
  /CHARACTER CARD CONTEXT/.test(built.prompt)
    && /drowned quarter of Khelt/.test(built.prompt),
  'this was empty for every roll before now')

console.log('\n── the opening scene informs Instant Action ──')
const { runQuickStart } = await import('../src/tracker/quickstart')
const SHEET = '[CHARACTER]\nName: Tessit\nHP: 9/9\n[/CHARACTER]'
const BIO = 'Species: Human\nPersonality: Watchful.'

state.generationQueue = [SHEET, BIO]
const sent: string[] = []
let mark = state.generations.length
const outcome = await runQuickStart({ genre: 'fantasy' }, text => { sent.push(text) })
check('it ran', outcome.ok, outcome.reason ?? '')

const creationPrompt = ((state.generations[mark] as {
  messages?: Array<{ content: string }>
})?.messages ?? []).map(m => m.content).join('\n')
check('the scenario reaches the generator',
  /canals have started giving back/.test(creationPrompt),
  'the point: roll someone who belongs in *this* story')
check('so does the opening scene',
  /ferryman will not take you further/.test(creationPrompt))

console.log('\n── without echoing the story back ──')
// The opening turn is sent into the chat. Folding the scene into the user's
// setup text would read the story back to the narrator that just told it.
check('an opening turn was sent', sent.length === 1, `${sent.length} message(s)`)
check('and it does not repeat the scenario',
  !/canals have started giving back/.test(sent[0] ?? ''),
  sent[0] ?? '')
check('nor the opening scene',
  !/ferryman/.test(sent[0] ?? ''), sent[0] ?? '')

console.log('\n── a level in the scenario is not the player’s level ──')
// `extractInstantActionLevel` scans for `level 5` and treats a hit as the
// character's starting level. The scenario says "a level 5 threat".
check('the scenario mentions a level at all',
  /level 5 threat/i.test(String(state.characterCards.get('card-1')?.scenario)),
  'otherwise this check proves nothing')
// Narrowed to the borrowed sentence on purpose: the shipped prompts talk about
// levels constantly ("Level N (avail/max)"), so a bare /level/ sweep would fail
// against text that has nothing to do with this.
check('the number was stripped out of the borrowed scenario',
  /a level threat is rumoured/i.test(creationPrompt)
    && !/a level 5 threat/i.test(creationPrompt),
  (creationPrompt.match(/a level[^.]{0,30}/i) ?? ['sentence not found'])[0])

console.log('\n── the user’s own setup keeps its digits ──')
settings.currentMemo = ''
state.generationQueue = [SHEET, BIO]
mark = state.generations.length
await runQuickStart(
  { genre: 'fantasy', instructions: 'Start at level 7, fresh off the boat.' },
  () => {},
)
const withSetup = ((state.generations[mark] as {
  messages?: Array<{ content: string }>
})?.messages ?? []).map(m => m.content).join('\n')
check('a level the user asked for still lands',
  /level 7/i.test(withSetup),
  'defusing applies to borrowed text only')

console.log('\n── a chat with no card still works ──')
state.chatCharacter.delete('chat-1')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await wait()
const bare = (globalThis as any).SillyTavern.getContext()
check('the context is empty rather than broken',
  bare.characterId === null && bare.characters.length === 0,
  `${JSON.stringify(bare.characterId)} / ${bare.characters.length}`)

settings.currentMemo = ''
state.generationQueue = [SHEET, BIO]
const cardless = await runQuickStart({ genre: 'fantasy' }, () => {})
check('and Instant Action still rolls someone', cardless.ok, cardless.reason ?? '')

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'card context test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
