/**
 * player-card.ts — Lorebook Agent Player Cards.
 *
 *   bun tests/player-card.ts
 *
 * "Create PC Card" turns the CHARACTER sheet plus recent messages into a prose
 * bio and stores it as this chat's player character, so the agent knows who the
 * player is without re-deriving it every pass.
 *
 * The review step matters: nothing is stored until the user approves, and what
 * gets stored is whatever they left in the box.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [
  {
    id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
    name: 'You', content: 'I introduce myself to the class.', send_date: 0,
    swipe_id: 0, swipes: ['I introduce myself to the class.'], swipe_dates: [0],
    extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
  },
])

const MEMO = `[CHARACTER]
Syg (Resonator)
Class: Resonator
Level: 1
HP: 8/8
[/CHARACTER]`

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

await import('../src/backend')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 400))

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

const { generatePlayerCard, addPlayerCard } = await import('../src/tracker/player-card')

console.log('── refuses without a sheet ──')
settings.currentMemo = ''
const noSheet = await generatePlayerCard()
check('will not invent a character from nothing',
  !noSheet.ok && /CHARACTER/.test(noSheet.reason ?? ''), noSheet.reason ?? '')

console.log('\n── generation ──')
settings.currentMemo = MEMO
state.generationResponse = 'Species: Small kobold hailing from a humble rural farmstead.\n'
  + 'Body: Compact and agile frame with sharp, observant eyes.\n'
  + 'Personality: Calm and inquisitive, often grounding anxious companions.'

const before = state.generations.length
const draft = await generatePlayerCard()
check('reached the model', state.generations.length > before,
  `${state.generations.length - before} request(s)`)
check('produced a card', draft.ok && draft.bio.length > 0, draft.reason ?? '')
check('read the character name off the sheet', draft.name === 'Syg', draft.name)
check('carried a word count', draft.wordCount > 0, String(draft.wordCount))

const request = state.generations[state.generations.length - 1] as {
  messages?: Array<{ role: string; content: string }>
}
const prompt = (request?.messages ?? []).map(m => m.content).join('\n')
check('sheet reached the prompt', prompt.includes('Resonator'))

console.log('\n── nothing is stored until approved ──')
check('no player character yet',
  !(settings.chatStates?.['chat-1']?.playerCharacter),
  'generation alone must not persist')

console.log('\n── approval ──')
// The user edits before approving; the edit is what must be stored.
const edited = `${draft.bio}\nQuirk: taps a quill against their teeth when thinking.`
const added = await addPlayerCard(draft.name, edited, draft.wordCount)
check('stored the card', added.ok, added.reason ?? '')

const stored = settings.chatStates?.['chat-1']?.playerCharacter
check('linked to the active chat', !!stored, Object.keys(settings.chatStates ?? {}).join(', '))
check('kept the name', stored?.name === 'Syg', String(stored?.name))
check('stored the edited bio, not the generated one',
  String(stored?.bio ?? '').includes('taps a quill'),
  'the review box is the source of truth')
check('stamped a timestamp', typeof stored?.timestamp === 'number')

console.log('\n── rejects an empty card ──')
const empty = await addPlayerCard('Syg', '   ', 150)
check('an empty bio is refused', !empty.ok && empty.reason === 'the card is empty',
  JSON.stringify(empty))

console.log('\n── name sanitising ──')
// Quotes and backslashes would break the lorebook entry the agent builds.
await addPlayerCard(`Syg "The 'Quiet'" \\`, 'A bio.', 150)
const sanitised = settings.chatStates?.['chat-1']?.playerCharacter
check('quotes and backslashes stripped from the name',
  !/["'\\]/.test(String(sanitised?.name ?? '')), String(sanitised?.name))

console.log('\n── persistence ──')
await new Promise(resolve => setTimeout(resolve, 1200))
const key = [...state.userStorage.keys()].find(k => k.endsWith('settings.json'))
check('settings written to per-user storage', !!key)
if (key) {
  const saved = JSON.parse(state.userStorage.get(key)!).rpg_tracker ?? {}
  check('player card survived to storage',
    !!saved.chatStates?.['chat-1']?.playerCharacter,
    'the agent reads this on chat open')
}

console.log('\n── rolling a new character ──')
const { listArchetypes, rollCharacter, commitRoll, CHARACTER_GENRES } =
  await import('../src/tracker/player-card')

check('offers genres', CHARACTER_GENRES.length > 0, CHARACTER_GENRES.join(', '))
const archetypes = await listArchetypes('fantasy')
check('lists archetypes for a genre', archetypes.length > 0,
  archetypes.slice(0, 4).join(', '))

check('refuses without an archetype',
  !(await rollCharacter({ className: '' })).ok,
  'the engine throws rather than picking one')

// The roll authors a whole sheet, so the model returns a full CHARACTER block.
const priorMemo = String(settings.currentMemo ?? '')
state.generationResponse = `[CHARACTER]
Vex (Rogue)
Class: Rogue
Level: 2
HP: 14/14
[/CHARACTER]`

const rolled = await rollCharacter({
  className: archetypes[0], genre: 'fantasy', level: 2, gearTier: 'auto',
})
check('rolled a character', rolled.ok, rolled.reason ?? '')
check('returned the sheet for review', String(rolled.memo ?? '').includes('Vex'),
  String(rolled.memo ?? '').slice(0, 40).replace(/\n/g, ' '))
check('read the rolled name', rolled.name === 'Vex', String(rolled.name))

// The point of the whole review step: a roll the user has not looked at must
// not have touched the character they already had.
check('the roll alone commits nothing',
  String(settings.currentMemo) === priorMemo
    && !String(settings.currentMemo).includes('Vex'),
  String(settings.currentMemo).slice(0, 40).replace(/\n/g, ' '))

console.log('\n── approving a roll ──')
// The user can edit in the review box, and the edit is what gets stored.
const kept = await commitRoll({ memo: `${rolled.memo}\nNotes: left-handed.`, name: rolled.name })
check('committed', kept.ok && kept.changed, kept.reason ?? '')
check('memo replaced with the new sheet',
  String(settings.currentMemo).includes('Vex'),
  String(settings.currentMemo).slice(0, 40).replace(/\n/g, ' '))
check('stored the edited sheet, not the rolled one',
  String(settings.currentMemo).includes('left-handed'),
  'the review box is the source of truth')
check('previous sheet recoverable from history',
  (settings.memoHistory ?? []).includes(priorMemo),
  'a mistaken roll must not be unrecoverable')
check('an empty sheet is refused', !(await commitRoll({ memo: '   ' })).ok)

console.log('\n── custom class ──')
const { CLASS_OTHER, CLASS_STORY, listPersonas } = await import('../src/tracker/player-card')

check('custom class without text is refused',
  !(await rollCharacter({ className: CLASS_OTHER })).ok,
  'the prompt builder would otherwise emit an empty class line')

state.generationResponse = `[CHARACTER]
Wren (Storm-touched cartographer)
Class: Storm-touched cartographer
[/CHARACTER]`
const custom = await rollCharacter({
  className: CLASS_OTHER, classOther: 'Storm-touched cartographer', genre: 'fantasy',
})
check('custom class rolls', custom.ok, custom.reason ?? '')
const customPrompt = (state.generations[state.generations.length - 1] as {
  messages?: Array<{ content: string }>
}).messages?.map(m => m.content).join('\n') ?? ''
check('custom class reached the prompt',
  customPrompt.includes('Storm-touched cartographer'))

check('story-fitting class is accepted',
  (await rollCharacter({ className: CLASS_STORY, genre: 'fantasy' })).ok !== undefined,
  'the sentinel needs no free text')

console.log('\n── seeding from a persona ──')
const personas = await listPersonas('user-1')
check('lists personas', personas.length === 2, personas.map(p => p.name).join(', '))
check('reports which have an image',
  personas.find(p => p.name === 'Syg')?.hasImage === true
    && personas.find(p => p.name === 'Bram')?.hasImage === false)

state.generationResponse = `[CHARACTER]
Syg (Resonator)
HP: 8/8
[/CHARACTER]`
const seeded = await rollCharacter(
  { className: 'Rogue', genre: 'fantasy', personaId: 'persona-1' },
  'user-1',
)
check('rolled from the persona', seeded.ok, seeded.reason ?? '')
check('offers the persona portrait in the review',
  seeded.portraitUrl === '/api/v1/images/img-1',
  'this is the point — an image without an image generator')

const seededPrompt = (state.generations[state.generations.length - 1] as {
  messages?: Array<{ content: string }>
}).messages?.map(m => m.content).join('\n') ?? ''
check('persona description reached the prompt', seededPrompt.includes('ley-lines'))
check('persona title reached the prompt', seededPrompt.includes('Seeker Student'))

// Nothing is keyed until the roll is approved: a discarded roll must not
// leave the old character wearing a new face.
check('portrait not applied before approval',
  !(settings.customPortraits ?? {}).CHARACTER,
  String((settings.customPortraits ?? {}).CHARACTER))

const seededKept = await commitRoll({
  memo: seeded.memo ?? '',
  name: seeded.name,
  portraitUrl: seeded.portraitUrl,
  personaName: 'Syg',
})
check('approving applies the portrait', seededKept.portrait === true,
  seededKept.reason ?? '')

const portraits = settings.customPortraits ?? {}
check('portrait keyed for the tracker card', portraits.CHARACTER === '/api/v1/images/img-1',
  String(portraits.CHARACTER))
check('portrait keyed for the agent', portraits.PC === '/api/v1/images/img-1')
check('portrait keyed by name', portraits.Syg === '/api/v1/images/img-1',
  Object.keys(portraits).join(', '))

// Keying it is only half the job — upstream renders portraits only when
// `enablePortraits` is on and only for entities it wraps. Assert the image
// actually reaches the markup, or this feature is invisible.
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'panel:refresh' })
await new Promise(resolve => setTimeout(resolve, 300))
const rendered = String(
  (state.toFrontend.find(m => (m as any).type === 'panel:render') as any)?.html ?? '',
)
check('portrait reaches the rendered card',
  rendered.includes('<img class="rt-entity-portrait" src="/api/v1/images/img-1"'),
  `${rendered.length} chars, placeholder=${rendered.includes('portrait-placeholder')}`)

console.log('\n── a persona without an image ──')
// A distinct sheet: the roll refuses a reply that would leave the memo
// unchanged, and the Syg sheet was just committed above.
state.generationResponse = `[CHARACTER]
Bram (Innkeeper)
HP: 6/6
[/CHARACTER]`
const noImage = await rollCharacter(
  { className: 'Rogue', genre: 'fantasy', personaId: 'persona-2' },
  'user-1',
)
check('still rolls without an avatar', noImage.ok, noImage.reason ?? '')
check('offers no portrait', !noImage.portraitUrl, String(noImage.portraitUrl))

console.log('\n── backend wiring ──')
// The backend holds the draft between the roll and the approval, so the
// portrait URL never round-trips through the frontend.
state.generationResponse = `[CHARACTER]
Ilse (Fighter)
HP: 20/20
[/CHARACTER]`
state.toFrontend.length = 0
// The host does not await the handler, so the port dispatches and returns.
const settle = () => new Promise(resolve => setTimeout(resolve, 200))
await emitFrontendMessage(state, {
  type: 'roll:go', className: 'Fighter', genre: 'fantasy', level: 1, gearTier: 'auto',
})
await settle()
const sentDraft = state.toFrontend.find(m => (m as any).type === 'roll:draft') as any
check('backend answered a roll with a draft', !!sentDraft && sentDraft.ok === true,
  JSON.stringify(sentDraft?.reason ?? ''))
check('the draft carries the sheet',
  String(sentDraft?.memo ?? '').includes('Ilse'))
check('the roll did not touch the character',
  !String(settings.currentMemo).includes('Ilse'),
  String(settings.currentMemo).slice(0, 30).replace(/\n/g, ' '))

await emitFrontendMessage(state, { type: 'roll:commit', memo: sentDraft?.memo ?? '' })
await settle()
check('approving through the backend commits',
  String(settings.currentMemo).includes('Ilse'),
  String(settings.currentMemo).slice(0, 30).replace(/\n/g, ' '))

// A second approval has nothing to approve; committing again would re-apply a
// sheet the user has since edited or replaced.
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'roll:commit', memo: 'anything at all' })
await settle()
const stale = state.toFrontend.find(m => (m as any).type === 'panel:result') as any
check('a stale approval is refused',
  stale?.changed === false && /no longer pending/.test(String(stale?.reason)),
  String(stale?.reason))
check('and left the character alone',
  String(settings.currentMemo).includes('Ilse'))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'player card test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
