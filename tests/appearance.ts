/**
 * appearance.ts — the panel palette, and drawn portraits.
 *
 *   bun tests/appearance.ts
 *
 * Upstream reaches four image providers directly, each with its own keys and
 * polling. Here `spindle.imageGen` is the host's own, using connections the
 * user already configured — so the port asks the host and lets it deal with
 * providers.
 *
 * The state most people are in is **no image gen configured at all**, and the
 * port has to say that plainly rather than fail obscurely. That is the first
 * thing checked.
 *
 * A theme is a map of `--rt-custom-*` variables that goes straight into a
 * stylesheet, so what a model returns has to be treated as untrusted.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

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
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

console.log('── portraits, with nothing set up ──')
const {
  describeForPortrait, generatePortrait, imageGenAvailable, portraitTargets,
} = await import('../src/tracker/portrait-gen')

// The default state for most people.
const unavailable = await imageGenAvailable()
check('says plainly that there is no image gen',
  !unavailable.ok && /no image generation connection/.test(unavailable.reason ?? ''),
  unavailable.reason ?? '')
check('and drawing refuses rather than failing obscurely',
  !(await generatePortrait('Syg')).ok)

console.log('\n── who could have one ──')
settings.currentMemo = `[CHARACTER]
Syg (Resonator)
HP: 8/8
[/CHARACTER]

[PARTY]
Kestrel — a ranger with a bad knee.
[/PARTY]`
const targets = await portraitTargets()
check('reads the cast off the tracker', targets.length >= 2, targets.join(', '))
check('including the player character', targets.some(name => /Syg/.test(name)))

console.log('\n── describing before drawing ──')
// The prompt is the cheap half; reading it first is how you find out the
// tracker thinks your ranger is a dwarf before paying to see it.
state.generationResponse = 'A wiry kobold resonator, ley-light in both hands, worn leathers.'
const described = await describeForPortrait('Syg')
check('wrote a prompt', described.ok && (described.prompt ?? '').length > 0,
  described.reason ?? (described.prompt ?? '').slice(0, 40))
check('without drawing anything', state.imageGenRequests.length === 0)

console.log('\n── drawing, once it is set up ──')
state.imageGenConnections.push({ id: 'imggen-1', name: 'local sd', has_api_key: true })
check('now available', (await imageGenAvailable()).ok)

const drawn = await generatePortrait('Syg')
check('drew one', drawn.ok, drawn.reason ?? '')
check('asked the host, not a provider directly', state.imageGenRequests.length === 1)
check('and sent the description', /resonator|kobold/i.test(
  String(state.imageGenRequests[0]?.prompt ?? '')),
  String(state.imageGenRequests[0]?.prompt ?? '').slice(0, 40))

// Stored as a Lumiverse URL: the engine only uploads when handed base64, and
// its upload path is SillyTavern's REST API, which does not exist here.
check('stored a host image URL, not base64',
  /^\/api\/v1\/images\//.test(String(settings.customPortraits?.Syg ?? '')),
  String(settings.customPortraits?.Syg))

const edited = await generatePortrait('Syg', 'A tall stern paladin in white.')
check('an edited prompt is what gets drawn',
  edited.ok && /paladin/i.test(String(state.imageGenRequests[1]?.prompt ?? '')),
  'the box is the source of truth, as everywhere else')

console.log('\n── the palette ──')
const {
  applyTheme, deleteTheme, generateTheme, loadTheme, readTheme, saveTheme, undoTheme,
} = await import('../src/tracker/theme')

check('starts on the shipped look', (await readTheme()).active === null)

await applyTheme({ '--rt-custom-bg': '#101014', '--rt-custom-accent': '#c8a24a' })
check('applied', (await readTheme()).active?.['--rt-custom-bg'] === '#101014')

// A theme goes straight into a stylesheet.
await applyTheme({
  '--rt-custom-bg': '#101014',
  '--rt-custom-accent': 'red; } body { display: none; } .x {',
  '--rt-not-a-real-var': 'oops',
} as never)
const guarded = (await readTheme()).active ?? {}
check('a value that could close the rule is dropped',
  !('--rt-custom-accent' in guarded),
  'model output must not be able to write arbitrary CSS')
check('and unknown variables are dropped too',
  !('--rt-not-a-real-var' in guarded), Object.keys(guarded).join(', '))
check('while the good value survives', guarded['--rt-custom-bg'] === '#101014')

console.log('\n── undo ──')
// A bad palette can make the panel unreadable, so this must not need the panel.
await undoTheme()
check('put back what was there',
  (await readTheme()).active?.['--rt-custom-accent'] === '#c8a24a',
  JSON.stringify((await readTheme()).active))

console.log('\n── saving palettes ──')
check('a nameless save is refused', !(await saveTheme('  ')).ok)
check('saved', (await saveTheme('Candlelight')).ok)
check('it is listed', (await readTheme()).saved.includes('Candlelight'))

await applyTheme(null)
check('back to the shipped look', (await readTheme()).active === null)
check('loading brings it back',
  (await loadTheme('Candlelight')).ok
    && (await readTheme()).active?.['--rt-custom-accent'] === '#c8a24a')
check('loading one that is gone is refused', !(await loadTheme('nope')).ok)
check('deleted', (await deleteTheme('Candlelight')).ok
  && !(await readTheme()).saved.includes('Candlelight'))

console.log('\n── mixing one ──')
check('an empty description is refused', !(await generateTheme('  ')).ok)

state.generationResponse = 'Sure! ```json\n' + JSON.stringify({
  '--rt-custom-bg': '#0b0d10', '--rt-custom-blur': '6px',
  '--rt-custom-border': '#2a2f36', '--rt-custom-text': '#e6e6e6',
  '--rt-custom-text-muted': '#9aa0a6', '--rt-custom-font': 'Georgia, serif',
  '--rt-custom-font-mono': 'Consolas, monospace', '--rt-custom-accent': '#d8a24a',
  '--rt-custom-accent-dim': '#8a6a2f', '--rt-custom-accent-bg': '#1a1509',
  '--rt-custom-card-border': '#22262c', '--rt-custom-shadow': '0 2px 8px #000',
  '--rt-custom-header-bg': '#12151a', '--rt-custom-card-bg': '#0f1216',
  '--rt-custom-card-header': '#161a20',
}) + '\n```'
const mixed = await generateTheme('a haunted crypt, candlelight on wet stone')
check('mixed a palette', mixed.ok, mixed.reason ?? '')
check('pulled the JSON out of the prose',
  mixed.vars?.['--rt-custom-accent'] === '#d8a24a', String(mixed.vars?.['--rt-custom-accent']))

state.generationResponse = 'I could not do that.'
const refused = await generateTheme('something')
check('a reply with no palette is refused', !refused.ok, refused.reason ?? '')

state.generationResponse = '{"--rt-custom-bg":"#000"}'
const thin = await generateTheme('something')
check('a mostly empty palette is refused',
  !thin.ok && /missing/.test(thin.reason ?? ''), thin.reason ?? '')

console.log('\n── the scene ──')
const { clearSceneArt, generateSceneArt, readScene } = await import('../src/tracker/immersion')

// The engine reads the place from the status footer the narrator writes, or
// from a `Location:` line in the memo — not from a [LOCATION] block.
settings.currentMemo = `[CHARACTER]
Syg (Resonator)
Location: Khelt, Rust-Lantern District, The Ash Door
[/CHARACTER]`

const scene = await readScene()
check('read the scene', scene.ok, scene.reason ?? '')
check('knows where the party is', /Ash Door/.test(scene.where ?? ''), String(scene.where))
check('and rendered it', (scene.html ?? '').length > 0, `${(scene.html ?? '').length} chars`)
check('with no art yet', scene.hasArt === false)

const painted = await generateSceneArt('user-1')
check('drew the scene', painted.ok, painted.reason ?? '')
// A location shot, not a character portrait: people in it would fight the
// NPC portraits the scene view already shows.
const scenePrompt = String(state.imageGenRequests.at(-1)?.prompt ?? '')
check('asked for a place, not a person',
  /establishing shot/i.test(scenePrompt) && /no people/i.test(scenePrompt),
  scenePrompt.slice(0, 50))
check('and named the location', /Ash Door|Khelt/.test(scenePrompt))

check('the art is stored where the renderer looks',
  Object.keys(settings.customLocationImages ?? {}).length === 1,
  Object.keys(settings.customLocationImages ?? {}).join(', '))
check('the scene now reports art', (await readScene()).hasArt === true)

await clearSceneArt()
check('and it can be removed', (await readScene()).hasArt === false,
  'so a place you dislike can be redrawn')

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'theme:read' })
await emitFrontendMessage(state, { type: 'portrait:gen-read' })
await wait()
check('the panel is sent the palette',
  !!state.toFrontend.find(m => (m as any).type === 'theme:state'))
const genState = state.toFrontend.find(m => (m as any).type === 'portrait:gen-state') as any
check('and whether portraits can be drawn', genState?.available === true,
  String(genState?.reason ?? ''))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 110)}`)

console.log(`\n${failures === 0 ? 'appearance test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
