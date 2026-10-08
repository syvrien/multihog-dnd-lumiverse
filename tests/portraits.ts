/**
 * portraits.ts — setting an entity's portrait by hand, and undoing a bad memo.
 *
 *   bun tests/portraits.ts
 *
 * Two gaps the port had left open, both of the same shape: a control that
 * looked live and wasn't.
 *
 *   - every entity card renders a portrait box saying "Drop image here or
 *     click to set portrait", and nothing was bound to it
 *   - every commit pushed the previous memo into `settings.memoHistory`, and
 *     nothing ever read it, so a bad state pass could not be undone
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'The party enters.', send_date: 0, swipe_id: 0,
  swipes: ['The party enters.'], swipe_dates: [0], extra: {},
  parent_message_id: null, branch_id: null, created_at: 0,
}])

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const settle = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 250))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await settle()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()

const {
  clearPortrait, currentPortrait, listPortraitChoices, setPortrait,
} = await import('../src/tracker/portraits')

console.log('── the choices offered ──')
const choices = await listPortraitChoices('user-1')
check('only personas that actually have an image', choices.length === 1,
  choices.map(c => c.name).join(', '))
check('resolved to a usable URL', choices[0]?.url === '/api/v1/images/img-1',
  String(choices[0]?.url))

console.log('\n── from a persona ──')
const fromPersona = await setPortrait('Kestrel (Ranger)', { personaId: 'persona-1' }, 'user-1')
check('set', fromPersona.ok, fromPersona.reason ?? '')
check('stored under the normalised name — the renderer looks it up that way',
  settings.customPortraits?.Kestrel === '/api/v1/images/img-1',
  Object.keys(settings.customPortraits ?? {}).join(', '))
check('reads back for the full card label',
  await currentPortrait('Kestrel (Ranger)') === '/api/v1/images/img-1')

check('a persona with no image is refused',
  !(await setPortrait('Kestrel', { personaId: 'persona-2' }, 'user-1')).ok,
  'persona-2 has no avatar')

console.log('\n── from an uploaded file ──')
// A 1x1 GIF is enough to prove the upload path; the bytes do not matter.
const TINY = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='
const uploaded = await setPortrait('Bram', { dataUrl: TINY, filename: 'bram.gif' }, 'user-1')
check('uploaded', uploaded.ok, uploaded.reason ?? '')
check('went through the host image store, not into settings',
  state.uploads.length === 1 && !String(settings.customPortraits?.Bram).startsWith('data:'),
  String(settings.customPortraits?.Bram))
check('kept the filename', state.uploads[0]?.filename === 'bram.gif',
  String(state.uploads[0]?.filename))

check('a non-image file is refused',
  !(await setPortrait('Bram', { dataUrl: 'data:text/plain;base64,aGk=' }, 'user-1')).ok)

console.log('\n── from a URL ──')
check('an http URL is accepted',
  (await setPortrait('Tiktik', { url: 'https://example.test/t.png' }, 'user-1')).ok)
// A `javascript:` string would otherwise land in an <img src> in the panel.
const hostile = await setPortrait('Tiktik', { url: 'javascript:alert(1)' }, 'user-1')
check('a non-http scheme is refused', !hostile.ok, hostile.reason ?? '')
check('and the good URL survived the refusal',
  settings.customPortraits?.Tiktik === 'https://example.test/t.png',
  String(settings.customPortraits?.Tiktik))

console.log('\n── removing one ──')
await clearPortrait('Kestrel (Ranger)')
check('gone', !settings.customPortraits?.Kestrel,
  Object.keys(settings.customPortraits ?? {}).join(', '))
check('the others are untouched',
  settings.customPortraits?.Bram && settings.customPortraits?.Tiktik)

console.log('\n── it reaches the rendered card ──')
settings.currentMemo = '[PARTY]\nBram (Innkeeper)\nHP: 6/6\n[/PARTY]'
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'panel:refresh' })
await settle()
const html = String(
  (state.toFrontend.find(m => (m as any).type === 'panel:render') as any)?.html ?? '',
)
check('the portrait is in the markup',
  html.includes(`src="${settings.customPortraits?.Bram}"`),
  `${html.length} chars`)
check('the box that opens the picker is there too',
  html.includes('rt-entity-portrait-container'))

console.log('\n── memo history ──')
const { readMemoHistory, writeMemo } = await import('../src/tracker/direct-prompt')

check('nothing to restore on a fresh chat', (await readMemoHistory()).length === 0)

await writeMemo('[CHARACTER]\nSyg (Resonator)\nHP: 8/8\n[/CHARACTER]')
await writeMemo('[CHARACTER]\nSyg (Resonator)\nHP: 2/8\n[/CHARACTER]')

const history = await readMemoHistory()
check('earlier versions are offered', history.length >= 2, String(history.length))
check('newest first',
  history[0]?.text.includes('8/8') && history[1]?.text.includes('Innkeeper'),
  history.map(h => h.label).join(' | '))
check('labelled by something readable, not a bracket tag',
  history[0]?.label === 'Previous version — Syg (Resonator)', history[0]?.label ?? '')
check('the current version is not offered as a version to go back to',
  !history.some(entry => entry.text === settings.currentMemo))

// Restoring is loading the old text and committing it the normal way, so it
// keeps history rather than replacing it.
const restored = await writeMemo(history[0].text)
check('restoring commits', restored.ok && restored.changed, restored.reason ?? '')
check('the bad version is itself recoverable',
  (await readMemoHistory()).some(entry => entry.text.includes('2/8')),
  'undo must not be a one-way door')

console.log('\n── the editor is handed both ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'memo:read' })
await settle()
const content = state.toFrontend.find(m => (m as any).type === 'memo:content') as any
check('sent the current memo', String(content?.text ?? '').includes('8/8'))
check('sent the history with it', (content?.history ?? []).length > 0,
  String((content?.history ?? []).length))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'portraits test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
