/**
 * polish.ts — the four small things: synopses, coalescing, animations, search.
 *
 *   bun tests/polish.ts
 *
 * All four are leaf modules upstream keeps in `src/ui/panel/**`, the directory
 * this port replaces wholesale. They come across because they import nothing
 * and assume nothing about SillyTavern — but "it ported" is not the claim worth
 * testing. The claims are:
 *
 *   - a card synopsis reads better than the truncation it replaces, on cards
 *     and on the plain prose that makes up most of a lorebook;
 *   - coalescing collapses a burst *and still ends on the newest state* — a
 *     coalescer that drops the last call is worse than none;
 *   - the animations refuse to animate across a chat switch;
 *   - the settings index covers every field, including by settings key.
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
const wait = (ms = 400): Promise<unknown> => new Promise(resolve => setTimeout(resolve, ms))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

console.log('── card synopsis ──')
const synopsis = await import('../src/engine/src/ui/panel/card-synopsis.js') as {
  getCardListFirstSentence: (content: string) => string
  getCardLibraryBlurb: (content: string) => string
}

// A stored card is labelled fields. Truncating the head of one shows headers.
const CARD = `Species: Half-orc, mid thirties.
Body: Broad through the shoulders, a hand missing two fingers.
Appearance: Grey-green, close-cropped hair, a coat too good for the work.
Personality: Patient until she is not. Keeps her voice low on purpose.
Brief Background: Ran cargo out of Khelt for eleven years.`

const raw = CARD.replace(/\s+/g, ' ').trim().slice(0, 60)
check('the old truncation showed field headers', /^Species:/.test(raw), raw)

const line = synopsis.getCardListFirstSentence(CARD)
check('the synopsis is a sentence about the person', line.length > 0, line)
check('and does not lead with a field name', !/^\s*(Species|Body|Appearance)\s*:/.test(line), line)

const blurb = synopsis.getCardLibraryBlurb(CARD)
check('the library blurb carries the personality too',
  /Patient until she is not/.test(blurb), blurb.replace(/\n/g, ' ').slice(0, 70))

// Most of a campaign's lorebook is prose, not cards. `extractCoreFields` has a
// fallback for exactly that: the first meaningful lines, cut at the first
// sentence — still a better preview than 240 raw characters.
const prose = synopsis.getCardListFirstSentence(
  'The Ash Door stands in a wall with no building behind it. Nobody agrees who put it there.')
check('prose gets its first sentence rather than being mangled',
  prose === 'The Ash Door stands in a wall with no building behind it.', prose)
check('and empty content stays empty', synopsis.getCardListFirstSentence('') === '')

console.log('\n── it reaches the browsers ──')
const { listLibrary } = await import('../src/tracker/npc-library')
settings.npcLibrary = [{
  id: 'card-1', name: 'Vessa', keys: ['Vessa'], content: CARD, notes: '',
  portraitPath: '', updatedAt: 1,
}]
const cards = await listLibrary()
check('the library row carries a blurb',
  /Patient until she is not/.test(cards[0]?.blurb ?? ''),
  (cards[0]?.blurb ?? '').replace(/\n/g, ' ').slice(0, 60))

console.log('\n── coalescing repaints ──')
const { createCoalescedRefresh } = await import(
  '../src/engine/src/ui/panel/refresh-coalescer.js') as {
  createCoalescedRefresh: (
    run: (...args: any[]) => Promise<unknown>,
  ) => (...args: any[]) => Promise<void>
}

const seen: string[] = []
let inFlight = 0
let overlapped = false
const slow = createCoalescedRefresh(async (label: string) => {
  inFlight++
  if (inFlight > 1) overlapped = true
  await new Promise(resolve => setTimeout(resolve, 20))
  seen.push(label)
  inFlight--
})

// A single turn asks for a repaint from the tracker pass, the agent, world
// progression and the map updater.
const burst = [slow('a'), slow('b'), slow('c'), slow('d')]
await Promise.all(burst)

check('it did not render all four', seen.length < 4, seen.join(', '))
check('and never ran two at once', !overlapped)
// The property that makes this safe: the panel still ends on the newest state.
check('the last request still won', seen.at(-1) === 'd', seen.join(', '))
check('the first one was not skipped', seen[0] === 'a', seen.join(', '))

console.log('\n── the panel repaint uses it ──')
state.toFrontend.length = 0
await Promise.all([
  emitFrontendMessage(state, { type: 'panel:refresh' }),
  emitFrontendMessage(state, { type: 'panel:refresh' }),
  emitFrontendMessage(state, { type: 'panel:refresh' }),
])
await wait()
const renders = state.toFrontend.filter(m => (m as any).type === 'panel:render')
check('three refreshes did not send three repaints', renders.length < 3,
  `${renders.length} repaint(s)`)
check('but the panel was still repainted', renders.length >= 1)
check('and every repaint says which chat it belongs to',
  renders.every(m => 'chatId' in (m as any)),
  'the animations key on it')

console.log('\n── animations ──')
const xp = await import('../src/engine/src/ui/panel/xp-gain-animation.js') as {
  getXpGainTransition: (previous: unknown, next: unknown) => unknown
  formatAnimatedXpValue: (current: number, max: number, asPercent: boolean) => string
}
const bars = await import('../src/engine/src/ui/panel/bar-change-animation.js') as {
  getBarChangeTransition: (previous: unknown, next: unknown) => unknown
  getBarTrickleDuration: (delta: number, max: number, reduced?: boolean) => number
}

const gained = xp.getXpGainTransition(
  { current: 300, max: 1000, level: '4', showAsPercentage: false },
  { current: 440, max: 1000, level: '4', showAsPercentage: false },
) as { gained: number } | null
check('an XP gain is a transition worth playing', gained?.gained === 140,
  String(gained?.gained))

// Levelling changes the denominator, so the bar cannot be interpolated.
const levelled = xp.getXpGainTransition(
  { current: 900, max: 1000, level: '4', showAsPercentage: false },
  { current: 40, max: 1400, level: '5', showAsPercentage: false },
)
check('a level-up is not animated as a gain', levelled === null,
  'the bar would have to run backwards')

check('losing XP is not animated either',
  xp.getXpGainTransition(
    { current: 400, max: 1000, level: '4', showAsPercentage: false },
    { current: 200, max: 1000, level: '4', showAsPercentage: false },
  ) === null)

// `animateChanges` is per-bar and comes off the rendered markup: a bar the
// renderer did not mark stays still. Omitting it here is what a wrong fixture
// looks like, and the engine refusing is correct.
check('a bar the renderer did not mark is not animated',
  bars.getBarChangeTransition(
    { id: 'hp', kind: 'bar', current: 34, max: 34 },
    { id: 'hp', kind: 'bar', current: 27, max: 34 },
  ) === null)

const hpDrop = bars.getBarChangeTransition(
  { id: 'hp', kind: 'bar', current: 34, max: 34, animateChanges: true },
  { id: 'hp', kind: 'bar', current: 27, max: 34, animateChanges: true },
) as { delta: number } | null
check('a marked bar change is a transition', hpDrop?.delta === -7, String(hpDrop?.delta))

// Comparing two different scales would draw a misleading delta segment.
check('a changed maximum renders immediately instead',
  bars.getBarChangeTransition(
    { id: 'hp', kind: 'bar', current: 34, max: 34, animateChanges: true },
    { id: 'hp', kind: 'bar', current: 34, max: 48, animateChanges: true },
  ) === null,
  'levelling up is not a bar sliding')
// Reduced motion shortens rather than removes: the count is information.
check('reduced motion shortens the trickle',
  bars.getBarTrickleDuration(7, 34, true) < bars.getBarTrickleDuration(7, 34, false),
  `${bars.getBarTrickleDuration(7, 34, true)}ms vs ${bars.getBarTrickleDuration(7, 34, false)}ms`)

console.log('\n── the animation wrapper refuses across chats ──')
/*
 * These run in the browser and read the rendered markup, so the capture path
 * needs enough of a DOM to be exercised at all. `readXpSnapshot` gates on
 * `instanceof HTMLElement`, which does not exist in a Bun process — so a real
 * (if tiny) class stands in, and the row is an instance of it.
 */
class FakeElement {
  dataset: Record<string, string> = {}
  querySelector(): unknown { return null }
  querySelectorAll(): unknown[] { return [] }
}
;(globalThis as Record<string, unknown>).HTMLElement = FakeElement

const xpRow = new FakeElement()
xpRow.dataset = {
  xpCurrent: '300', xpMax: '1000', xpLevel: '4', xpShowPercentage: 'false',
}
const container = new FakeElement()
container.dataset = { rtXpAnimationContext: 'chat-1', rtBarAnimationContext: 'chat-1' }
container.querySelector = () => xpRow
container.querySelectorAll = () => []

const { capturePanelAnimations, playPanelAnimations } = await import('../src/ui/animations')
const fakeContainer = container as unknown as HTMLElement

const sameChat = capturePanelAnimations(fakeContainer, 'chat-1')
check('the same chat is a context match',
  (sameChat.xp as { contextMatches?: boolean })?.contextMatches === true,
  JSON.stringify(sameChat.xp).slice(0, 70))
check('and it read the numbers that were on screen',
  (sameChat.xp as { previous?: { current?: number } })?.previous?.current === 300,
  String((sameChat.xp as { previous?: { current?: number } })?.previous?.current))

const otherChat = capturePanelAnimations(fakeContainer, 'chat-2')
check('a different chat is not a match',
  (otherChat.xp as { contextMatches?: boolean })?.contextMatches === false,
  'a bar sliding from another campaign is worse than no animation')

let threw = false
try { playPanelAnimations(fakeContainer, otherChat) } catch { threw = true }
check('and playing a non-match does not throw', !threw,
  'decoration must never be able to take the panel with it')
check('nor does playing with nothing captured',
  (() => { try { playPanelAnimations(null, null); return true } catch { return false } })())

delete (globalThis as Record<string, unknown>).HTMLElement

console.log('\n── settings search ──')
// The index is built in the browser, so what is checked here is the schema it
// is built from: every field must be findable, including by its settings key.
const { SETTINGS_SCHEMA } = await import('../src/shared/settings-schema')
const indexed: Array<{ key: string; text: string }> = []
for (const section of SETTINGS_SCHEMA) {
  for (const field of section.fields) {
    indexed.push({
      key: field.key,
      text: [section.title, field.label, field.help ?? '', field.key].join(' ').toLowerCase(),
    })
  }
  for (const group of section.groups ?? []) {
    for (const field of group.fields) {
      indexed.push({
        key: field.key,
        text: [section.title, group.title, field.label, field.help ?? '', field.key]
          .join(' ').toLowerCase(),
      })
    }
  }
}
check('every field is indexed', indexed.length > 30, `${indexed.length} fields`)
check('collapsed groups are indexed too',
  SETTINGS_SCHEMA.some(section => (section.groups ?? []).length > 0)
    && indexed.some(entry => entry.key === 'maxTokens'),
  'a match hidden inside a closed group is the same as no match')

const find = (query: string): number =>
  indexed.filter(entry => entry.text.includes(query.toLowerCase())).length

check('searching a label finds it', find('lookback') > 0, `${find('lookback')} hit(s)`)
// Someone reading a log line about `routerCampaignPrefix` should be able to
// paste it in, even though nothing on screen says that word.
check('searching a settings key finds it', find('routerCampaignPrefix') > 0)
check('searching help text finds it', find('swipe') > 0, `${find('swipe')} hit(s)`)
check('a nonsense query finds nothing', find('zzzznotasetting') === 0)

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'polish test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
