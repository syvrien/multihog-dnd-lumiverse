/**
 * quickstart.ts — Instant Action: genre in, started story out.
 *
 *   bun tests/quickstart.ts
 *
 * This is the one flow that commits without showing you anything first, so the
 * checks are about what actually lands: a [CHARACTER] sheet in the memo, a
 * Player Card stored against this chat, and an opening turn in the chat itself.
 * "It returned ok" is not evidence of any of those.
 *
 * The step upstream has that this port deliberately drops — creating a
 * SillyTavern persona named after the character — is asserted as absent, since
 * a future port of `character-creator.js` re-introducing it would throw on
 * globals this host has no shim for.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'Hello?', send_date: 0, swipe_id: 0, swipes: ['Hello?'],
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
settings.enabled = true

const { rollName, runQuickStart } = await import('../src/tracker/quickstart')

// The host seeds a persona; what matters is that Quick Start adds none.
const personasBefore = state.personas.length

const SHEET = `[CHARACTER]
Name: Vessa Corrin
Class: Warden
Level: 4
HP: 31/31
[/CHARACTER]`

const BIO = 'Species: Human\nAppearance: Weather-worn, grey at the temples.\n'
  + 'Personality: Patient until she is not.'

console.log('── rolling a name ──')
const rolled = await rollName('fantasy')
check('a fantasy name comes from the genre pool', rolled.length > 0, rolled)
check('an unknown genre falls back rather than failing',
  (await rollName('interpretive-dance')).length > 0)

console.log('── the pipeline ──')
// The character generator writes the sheet into the memo itself, so the first
// reply has to be the sheet; the second is the Player Card prose.
state.generationQueue = [SHEET, BIO]

const sent: string[] = []
const steps: string[] = []
const before = state.generations.length

const outcome = await runQuickStart(
  { genre: 'fantasy', name: 'Vessa Corrin', sendStarter: true },
  text => { sent.push(text) },
  label => steps.push(label),
)

check('it succeeded', outcome.ok, outcome.reason ?? '')
check('it made two model calls, not one',
  state.generations.length - before === 2,
  `${state.generations.length - before} call(s) — sheet, then Player Card`)

console.log('\n── what actually landed ──')
check('the character sheet is in the memo',
  /\[CHARACTER\]/.test(String(settings.currentMemo)) && /Vessa Corrin/.test(String(settings.currentMemo)),
  String(settings.currentMemo).slice(0, 60).replace(/\n/g, ' '))
check('it reported the name it settled on', outcome.name === 'Vessa Corrin',
  String(outcome.name))

const card = settings.chatStates?.['chat-1']?.playerCharacter
check('a Player Card was stored against this chat', !!card,
  card ? 'present' : 'chat state has no playerCharacter')
check('the card holds the generated prose',
  /Weather-worn/.test(String(card?.bio ?? '')), String(card?.bio ?? '').slice(0, 40))
check('and is filed under the character name', card?.name === 'Vessa Corrin',
  String(card?.name))

console.log('\n── the story starts ──')
check('an opening turn was sent', sent.length === 1, `${sent.length} message(s)`)
check('and it is the opening line, not the setup text',
  /Begin the adventure/i.test(sent[0] ?? ''), sent[0] ?? '')
check('it reported progress along the way', steps.length >= 3, steps.join(' | '))
check('naming what it was doing, not just "working"',
  steps.some(step => /Creating character/i.test(step))
    && steps.some(step => /Player Card/i.test(step)),
  steps.join(' | '))

console.log('\n── the persona step is deliberately absent ──')
// Upstream then writes into SillyTavern's `power_user.persona_descriptions`.
// Lumiverse owns personas; a port that reinstated that call would throw on
// globals with no shim, and would create an account-level persona unasked.
check('no persona was created', state.personas.length === personasBefore,
  state.personas.map(p => String(p.name)).join(', '))
check('and nothing failed quietly trying',
  !state.logs.some(entry => /persona/i.test(entry.message) && entry.level === 'error'),
  state.logs.find(entry => /persona/i.test(entry.message))?.message ?? '')

console.log('\n── opting out of the opening turn ──')
settings.currentMemo = ''
state.generationQueue = [SHEET, BIO]
const quiet: string[] = []
const held = await runQuickStart(
  { genre: 'scifi', sendStarter: false },
  text => { quiet.push(text) },
)
check('it still built the character', held.ok, held.reason ?? '')
check('but sent nothing', quiet.length === 0)
check('and said so', held.started === false)

console.log('\n── setup text ──')
settings.currentMemo = ''
state.generationQueue = [SHEET, BIO]
const withSetup: string[] = []
const mark = state.generations.length
await runQuickStart(
  { genre: 'horror', instructions: 'Shipwrecked on an uncharted coast. Level 3.' },
  text => { withSetup.push(text) },
)
const creationPrompt = ((state.generations[mark] as {
  messages?: Array<{ content: string }>
})?.messages ?? []).map(m => m.content).join('\n')
check('the setup reaches the character generator',
  /uncharted coast/i.test(creationPrompt),
  'otherwise the box is decorative')
check('and rides along on the opening turn',
  /uncharted coast/i.test(withSetup[0] ?? ''), withSetup[0] ?? '')

console.log('\n── failures are reported, not swallowed ──')
settings.currentMemo = ''
state.generationQueue = []
state.generationResponse = 'I am not going to do that.'
const refused = await runQuickStart({ genre: 'fantasy' }, () => {})
check('a reply with no character sheet fails the run', !refused.ok, String(refused.reason))
check('and says why', /character/i.test(refused.reason ?? ''), refused.reason ?? '')

console.log('\n── guards ──')
state.granted.delete('generation')
check('no generation permission, no run',
  !(await runQuickStart({ genre: 'fantasy' }, () => {})).ok)
state.granted.add('generation')

console.log('\n── through the panel ──')
settings.currentMemo = ''
state.generationQueue = [SHEET, BIO]
state.toFrontend.length = 0
await emitFrontendMessage(state, {
  type: 'quickstart:run', genre: 'fantasy', sendStarter: false,
})
await wait(700)

check('the panel is told each step',
  state.toFrontend.filter(m => (m as any).type === 'quickstart:step').length >= 3,
  String(state.toFrontend.filter(m => (m as any).type === 'quickstart:step').length))
const done = state.toFrontend.find(m => (m as any).type === 'quickstart:done') as any
check('and told the outcome', done?.ok === true, String(done?.reason ?? ''))
check('the panel is repainted with the new sheet',
  state.toFrontend.some(m => (m as any).type === 'panel:render'
    && /Vessa Corrin/.test(String((m as any).html ?? ''))),
  'the sheet was written by the generator, so nothing else would repaint it')

await emitFrontendMessage(state, { type: 'quickstart:roll-name', genre: 'horror' })
await wait()
check('the reroll button gets a name back',
  !!(state.toFrontend.find(m => (m as any).type === 'quickstart:name') as any)?.name)

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'quickstart test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
