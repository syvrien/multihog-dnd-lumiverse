/**
 * auto-art.ts — portraits drawn without being asked, and only then.
 *
 *   bun tests/auto-art.ts
 *
 * Upstream's Auto-Generate options draw newcomers as they appear. The engine
 * has all the logic; the port never called it. This checks that it now runs —
 * through the host's image generation — and, since every image is a paid call,
 * that it never draws anything nobody asked for: not with the options off, not
 * a campaign's existing cast on opening it, not the same face twice, and not a
 * description-writing model call when there is nothing to draw with.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const msg = (chatId: string): never => ([{
  id: 'm-' + chatId, chat_id: chatId, index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'x', send_date: 0, swipe_id: 0, swipes: ['x'],
  swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
}] as never)
for (const id of ['chat-a', 'chat-b']) state.messages.set(id, msg(id))
state.generationResponse = 'A weathered adventurer in travel-stained leathers.'

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
  await wait(400)
}
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const { writeMemo } = await import('../src/tracker/direct-prompt')
const repaint = async (): Promise<void> => {
  await emitFrontendMessage(state, { type: 'panel:refresh' })
  await wait(900)
}
const memo = (party: string[], enemies: string[] = []): string => [
  '[CHARACTER]', 'Syg (Resonator)', 'HP: 8/8', '[/CHARACTER]',
  '[PARTY]', ...party.map(name => `${name}: 10/10 HP`), '[/PARTY]',
  ...(enemies.length ? ['[COMBAT]', 'Combat Round 1', ...enemies.map(name => `${name}: 7/7 HP`), '[/COMBAT]'] : []),
].join('\n')
const drawn = (): string[] => state.imageGenRequests.map(r => String(r.prompt ?? ''))
const patch = async (changes: Record<string, unknown>): Promise<void> => {
  await emitFrontendMessage(state, { type: 'settings:patch', patch: changes })
  await wait(900)
}

console.log('── off unless switched on ──')
const { SETTINGS_SCHEMA } = await import('../src/shared/settings-schema')
const art = SETTINGS_SCHEMA.find(section => section.id === 'art')
const { AUTO_ART_KEYS } = await import('../src/tracker/auto-art')
check('the options are in the settings', !!art && AUTO_ART_KEYS.every(key => art.fields.some(f => f.key === key)))
check('every one defaults to off', AUTO_ART_KEYS.every(key =>
  art?.fields.find(f => f.key === key)?.fallback === false && settings[key] !== true))

// No image connection yet, as for most users who never set one up.
state.toFrontend.length = 0
await go('chat-a')
await writeMemo(memo(['Mira', 'Tor']))
const callsBefore = state.generations.length
await repaint()
check('with everything off, nothing is drawn', state.imageGenRequests.length === 0)
check('and no model is asked to describe anyone', state.generations.length === callsBefore,
  `${state.generations.length - callsBefore} call(s)`)
check('nor is anyone without an image connection warned about a feature they never turned on',
  !state.toFrontend.some(m => (m as any).type === 'toast' && /Automatic art/.test((m as any).message)))
state.imageGenConnections.push({ id: 'imggen-1', name: 'local sd', has_api_key: true })

console.log('\n── switching an option on ──')
await patch({ portraitAutoGenerateParty: true })
await wait(1500)
check('draws the party there already', drawn().length === 2, `${drawn().length} drawn`)
check('through the host\'s image generation, with the description the model wrote',
  drawn().every(prompt => /weathered adventurer/.test(prompt)), drawn()[0]?.slice(0, 60))
check('and keeps each portrait', /^\/api\/v1\/images\//.test(String(settings.customPortraits?.Mira ?? ''))
  && /^\/api\/v1\/images\//.test(String(settings.customPortraits?.Tor ?? '')),
  JSON.stringify(settings.customPortraits ?? {}).slice(0, 120))

console.log('\n── newcomers ──')
await writeMemo(memo(['Mira', 'Tor', 'Kess']))
await repaint()
await wait(1200)
check('a new party member is drawn', drawn().length === 3, `${drawn().length} drawn`)
check('the others are not drawn again', !!settings.customPortraits?.Kess)
await repaint()
await wait(600)
check('and repainting again draws nobody', drawn().length === 3, `${drawn().length} drawn`)
await writeMemo(memo(['Mira', 'Tor', 'Kess'], ['Ghoul']))
await repaint()
await wait(800)
check('enemies wait for their own option', drawn().length === 3, `${drawn().length} drawn`)

console.log('\n── opening another campaign ──')
// chat-b already has a cast, none of whom has a portrait. Opening it must not
// bill for all of them: the first check only records who is there.
settings.chatStates['chat-b'] = { currentMemo: memo(['Oren', 'Pell']), customPortraits: {} }
await go('chat-b')
await wait(800)
// No repaint here on purpose: the arrival itself has to record the cast, or
// the first check would come after the newcomer below and record it too.
check('its existing cast is not drawn', drawn().length === 3, `${drawn().length} drawn: ${drawn().slice(3).join(' | ').slice(0, 80)}`)
await writeMemo(memo(['Oren', 'Pell', 'Quill']))
await repaint()
await wait(1200)
check('but a newcomer there is', drawn().length === 4, `${drawn().length} drawn`)
check('and only the newcomer', !settings.customPortraits?.Oren && !!settings.customPortraits?.Quill,
  Object.keys(settings.customPortraits ?? {}).join(', '))

console.log('\n── with nothing to draw with ──')
state.imageGenConnections.length = 0
state.toasts.length = 0
state.toFrontend.length = 0
const before = state.generations.length
await writeMemo(memo(['Oren', 'Pell', 'Quill', 'Rue']))
await repaint()
await writeMemo(memo(['Oren', 'Pell', 'Quill', 'Rue', 'Sel']))
await repaint()
check('no model call is spent describing anyone', state.generations.length === before,
  `${state.generations.length - before} call(s)`)
const warnings = state.toFrontend.filter(m => (m as any).type === 'toast' && /Automatic art/.test((m as any).message))
check('the user is told why, once', warnings.length === 1, `${warnings.length} warning(s)`)
check('saying what is missing', /no image generation connection/.test(String((warnings[0] as any)?.message)))
state.imageGenConnections.push({ id: 'imggen-1', name: 'local sd', has_api_key: true })

console.log('\n── location art ──')
await patch({ portraitAutoGenerateLocations: true })
check('drawing lorebook locations turns location images on, as upstream does', settings.locationImages === true)
check('and Real-Time mode off', settings.portraitAutoGenerateSceneView === false)
await patch({
  portraitAutoGenerateParty: false, portraitAutoGenerateLocations: false,
})

console.log('\n── the prompt arrives as written ──')
const { executeSlashCommandsWithOptions, SlashCommandParser } = await import('../src/compat/slash')
const tricky = 'A "masked" duelist, style=noir, back\\slash and all'
// Exactly how the engine builds it in `generatePortraitDirect`.
const escaped = tricky.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
const count = state.imageGenRequests.length
const result = await new SlashCommandParser()
  .parse(`/imagine quiet=true gallery=false extend=false "${escaped}"`, true, null, new AbortController())
  .execute()
check('the engine\'s /imagine reaches the host', state.imageGenRequests.length === count + 1 && !result.isError,
  result.errorMessage ?? '')
check('with its quotes, backslashes and = intact', state.imageGenRequests.at(-1)?.prompt === tricky,
  String(state.imageGenRequests.at(-1)?.prompt))
check('and the image comes back on .pipe', /^\/api\/v1\/images\//.test(result.pipe), result.pipe)
const stopped = new AbortController()
stopped.abort()
const aborted = await new SlashCommandParser().parse(`/imagine "${escaped}"`, true, null, stopped).execute()
check('a stopped request draws nothing and says so', aborted.isAborted && state.imageGenRequests.length === count + 1)
let threw = ''
try {
  await executeSlashCommandsWithOptions('/imagine ""')
} catch (error) {
  threw = (error as Error).message
}
check('an empty prompt is refused, not sent', /empty/.test(threw), threw)

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'automatic art test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
