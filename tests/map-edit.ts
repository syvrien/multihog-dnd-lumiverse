/**
 * map-edit.ts — correcting a map, and undoing what changed it.
 *
 *   bun tests/map-edit.ts
 *
 * The viewer landed first and could only ever be right or annoying. These
 * checks are about the write path, and specifically about what it *refuses*:
 * the whole value of editing a map through the engine's validator rather than
 * a plain textarea is that a dangling exit or a duplicate id is caught at the
 * field, not discovered three sessions later when the Updater trips over it.
 *
 * The fixture is built with the engine's own constructors rather than hand-
 * written JSON — a map document I invented would prove the test passes, not
 * that the feature works.
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

const editorLib = await import('../src/engine/map-editor-lib.js') as any
const reality = await import('../src/engine/dungeon-reality.js') as any

// A two-room site the engine itself considers well formed.
const seed = editorLib.createMapEditorDocument({
  site: 'The Ash Door',
  kind: 'DUNGEON',
  entrance: 'Threshold',
})
const secondId = editorLib.allocateMapEditorId(seed, 'Flooded Nave', 'area')
seed.areas.push({
  id: secondId,
  name: 'Flooded Nave',
  knowledge: 'RUMORED',
  geometry: ['Ankle-deep water across cracked flagstones.'],
  connections: [{ to: seed.areas[0].id, state: 'OPEN', detail: '' }],
})
seed.areas[0].connections.push({ to: secondId, state: 'OPEN', detail: '' })

const BOOK = 'TestCampaign_Locations'
const book = { id: 'book-maps', name: BOOK, description: '', metadata: {}, created_at: 0, updated_at: 0 }
state.books.set(book.id, book)
state.entries.set('entry-map', {
  id: 'entry-map',
  world_book_id: book.id,
  key: ['The Ash Door'],
  keysecondary: [],
  comment: 'The Ash Door',
  content: `A soot-black door in a wall that has no building behind it.\n\n[MAP]\n${
    reality.serializeDungeonMapDocument(seed)}\n[/MAP]`,
  constant: false, selective: false, disabled: false,
  order_value: 0, position: 0, probability: 100, depth: 0,
})

// The book index was built at boot, before the fixture existed.
const { invalidateWorldInfoCache } = await import('../src/compat/world-info')
invalidateWorldInfoCache()

const {
  exportMap, importMap, readMapForEdit, restoreMapSnapshot, saveMapEdit,
} = await import('../src/tracker/map-edit')

const ID = `${BOOK}::0`

/** What is actually stored right now, read back through the engine. */
const stored = (): Record<string, any> => {
  const entry = state.entries.get('entry-map')
  const attachment = reality.getDungeonMapAttachment({
    content: entry.content, comment: entry.comment,
  })
  return reality.parseDungeonMapDocument(attachment.content, 'The Ash Door').document
}

console.log('── opening a map ──')
const draft = await readMapForEdit(ID)
check('it opened', draft.ok, draft.reason ?? '')
check('it is the right site', draft.site === 'The Ash Door', String(draft.site))
check('the document came back as JSON',
  !!draft.text && JSON.parse(draft.text!).areas.length === 2,
  `${draft.text?.length ?? 0} chars`)
check('opening took a restore point', (draft.history ?? []).length === 1,
  (draft.history ?? []).map(h => h.note).join(', '))
check('and it says the version was the one found there',
  draft.history?.[0]?.note === 'as found')
check('the editor is told which values are legal',
  Array.isArray(draft.enums?.connectionStates) && draft.enums!.connectionStates.length > 0,
  Object.keys(draft.enums ?? {}).join(', '))

console.log('\n── opening again does not stack copies ──')
// Otherwise the restore list fills with identical entries and stops being a
// list of changes.
const again = await readMapForEdit(ID)
check('still one restore point', (again.history ?? []).length === 1,
  String((again.history ?? []).length))

console.log('\n── a good edit ──')
const edited = JSON.parse(draft.text!)
edited.areas[1].name = 'The Drowned Nave'
edited.areas[1].geometry = ['Ankle-deep water across cracked flagstones.', 'A collapsed altar.']
const saved = await saveMapEdit(ID, JSON.stringify(edited, null, 2))
check('it saved', saved.ok, `${saved.reason ?? ''} ${(saved.errors ?? []).join('; ')}`)
check('the change reached the lorebook entry',
  stored().areas[1].name === 'The Drowned Nave', String(stored().areas[1].name))
check('and it kept the rest of the entry',
  /soot-black door/.test(String(state.entries.get('entry-map').content)),
  'the map lives in a section, not the whole entry')
// The snapshot taken on open *is* the pre-edit version, so pushing another
// would be a duplicate. Restoring it is what proves it is the right one.
check('the version from before the edit is still the only restore point',
  (saved.history ?? []).length === 1,
  (saved.history ?? []).map(h => h.note).join(', '))

console.log('\n── edits that must be refused ──')
// Each of these parses as JSON. That is the point: JSON validity says nothing
// about whether the document describes a place.
const brokenExit = JSON.parse(draft.text!)
brokenExit.areas[0].connections = [{ to: 'a-room-that-does-not-exist', state: 'OPEN', detail: '' }]
const exitResult = await saveMapEdit(ID, JSON.stringify(brokenExit))
check('an exit to nowhere is refused', !exitResult.ok)
check('and the field is named',
  (exitResult.errors ?? []).some(problem => /connections\[0\]\.to/.test(problem)),
  (exitResult.errors ?? [])[0] ?? '')

const duplicate = JSON.parse(draft.text!)
duplicate.areas[1].id = duplicate.areas[0].id
const duplicateResult = await saveMapEdit(ID, JSON.stringify(duplicate))
check('a duplicate area id is refused', !duplicateResult.ok,
  (duplicateResult.errors ?? [])[0] ?? '')

const renamed = JSON.parse(draft.text!)
renamed.site = 'Somewhere Else Entirely'
const renamedResult = await saveMapEdit(ID, JSON.stringify(renamed))
check('renaming the site is refused', !renamedResult.ok,
  'the entry, its keywords and every reference key off the existing name')

const notJson = await saveMapEdit(ID, 'this is not a map')
check('text that is not JSON is refused', !notJson.ok, notJson.reason ?? '')

check('nothing was written by any of those',
  stored().areas[1].name === 'The Drowned Nave',
  'a refused edit must leave the stored map exactly as it was')

console.log('\n── undo ──')
// Opening a changed map snapshots it too, so the stack is newest-first and the
// document this campaign started with is the last entry.
const points = (await readMapForEdit(ID)).history ?? []
const oldest = points.length - 1
check('the original is still in the list', points.length >= 2,
  `${points.length} point(s): ${points.map(p => p.note).join(', ')}`)

const restored = await restoreMapSnapshot(ID, oldest)
check('it restored', restored.ok, restored.reason ?? '')
check('the original name is back',
  stored().areas[1].name === 'Flooded Nave', String(stored().areas[1].name))
// Undoing an undo has to work, or the button is a trap. Index 0 is now the
// just-restored state, so the edit that was undone sits directly behind it.
const afterRestore = (await readMapForEdit(ID)).history ?? []
await restoreMapSnapshot(ID, 1)
check('the restore can itself be undone',
  stored().areas[1].name === 'The Drowned Nave',
  `${String(stored().areas[1].name)} — ${afterRestore.length} point(s)`)
check('a restore point that is gone is refused',
  !(await restoreMapSnapshot(ID, 99)).ok)

console.log('\n── export and import ──')
const exported = await exportMap(ID)
check('exported', exported.ok, exported.reason ?? '')
check('the filename is named after the site',
  /Ash Door/.test(exported.name ?? ''), String(exported.name))

const pack = JSON.parse(exported.json!)
check('it is a wrapped package, not a bare document',
  pack.format === 'multihog_map_package_v1', String(pack.format))
check('runtime host identity is stripped',
  !('hostSite' in pack.map) && !('hostBrief' in pack.map),
  'a map lifted out of one campaign must not carry its host into another')

pack.map.areas[1].name = 'The Nave of Silt'
const imported = await importMap(ID, JSON.stringify(pack))
check('a package can be imported back', imported.ok,
  `${imported.reason ?? ''} ${(imported.errors ?? []).join('; ')}`)
check('the imported layout landed',
  stored().areas[1].name === 'The Nave of Silt', String(stored().areas[1].name))
check('and the site name stayed the one already stored',
  stored().site === 'The Ash Door', String(stored().site))

const junkPack = await importMap(ID, '{"format":"multihog_map_package_v1","version":1,"map":{}}')
check('an empty map in a package is refused', !junkPack.ok,
  (junkPack.errors ?? [])[0] ?? junkPack.reason ?? '')

console.log('\n── missing things ──')
check('an unknown map id is refused', !(await readMapForEdit('Nope::0')).ok)
check('a malformed id is refused', !(await readMapForEdit('garbage')).ok)

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'maps:edit', id: ID })
await wait()
const panelDraft = state.toFrontend.find(m => (m as any).type === 'maps:draft') as any
check('the editor is sent the document', panelDraft?.ok === true && !!panelDraft?.text,
  String(panelDraft?.reason ?? ''))

state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'maps:save', id: ID, text: '{"broken":true}' })
await wait()
const panelSaved = state.toFrontend.find(m => (m as any).type === 'maps:saved') as any
check('a refused save reaches the panel with its reasons',
  panelSaved?.ok === false && (panelSaved?.errors?.length ?? 0) > 0,
  (panelSaved?.errors ?? []).slice(0, 1).join(''))

state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'maps:export', id: ID })
await wait()
check('export reaches the panel',
  !!(state.toFrontend.find(m => (m as any).type === 'maps:export') as any)?.json)

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)

console.log(`\n${failures === 0 ? 'map edit test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
