/**
 * connections.ts — which model each subsystem actually talks to.
 *
 *   bun tests/connections.ts
 *
 * Upstream gives Character Creation and the three map subsystems their own
 * connection, each defaulting to SillyTavern's "main API". There is no main API
 * here, so the port makes them follow the tracker's connection until the user
 * picks one.
 *
 * That was written as a one-shot — "if the source is not `profile`, copy the
 * tracker's" — which sets the source to `profile` and so makes the inherited
 * value indistinguishable from a deliberate choice. The second time it ran it
 * left everything alone. Changing the tracker's connection afterwards left
 * character creation generating against the old model, permanently and
 * silently.
 *
 * The settings UI then made it worse: a connection field patched the *tracker's*
 * `connectionSource` whatever field it belonged to, so picking a Map Architect
 * connection never set `mapArchitectConnectionSource` and the pick was thrown
 * away on the next sync.
 */

import { SECOND_CONNECTION, emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'
import { sourceKeyForProfileKey } from '../src/shared/settings-schema'

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
const wait = (): Promise<unknown> => new Promise(resolve => setTimeout(resolve, 350))

await import('../src/backend')
await emitHostEvent(state, 'CHAT_SWITCHED', { chatId: 'chat-1' })
await wait()

const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const { rollCharacter } = await import('../src/tracker/player-card')

console.log('── the key pairing ──')
// The engine reads a profile id only when its *own* source says `profile`.
check('a subsystem profile key maps to its own source key',
  sourceKeyForProfileKey('mapArchitectConnectionProfileId') === 'mapArchitectConnectionSource',
  sourceKeyForProfileKey('mapArchitectConnectionProfileId'))
check('the tracker\'s own maps to the bare source key',
  sourceKeyForProfileKey('connectionProfileId') === 'connectionSource')

console.log('\n── they start out following the tracker ──')
check('character creation follows',
  settings.characterCreationConnectionProfileId === settings.connectionProfileId,
  `${settings.characterCreationConnectionSource} / ${settings.characterCreationConnectionProfileId}`)
check('so do the map subsystems',
  settings.mapArchitectConnectionProfileId === settings.connectionProfileId
    && settings.mapRuntimeConnectionProfileId === settings.connectionProfileId
    && settings.mapEvolutionConnectionProfileId === settings.connectionProfileId)

console.log('\n── and keep following after the tracker moves ──')
// The regression: one roll used to freeze character creation on whatever the
// tracker was pointing at, for good.
state.generationResponse = '[CHARACTER]\nQ1 (Rogue)\n[/CHARACTER]'
await rollCharacter({ className: 'Rogue', genre: 'fantasy' })

state.connections.push(SECOND_CONNECTION)
await emitFrontendMessage(state, {
  type: 'settings:patch',
  patch: { connectionProfileId: 'conn-2', connectionSource: 'profile' },
})
await wait()

check('character creation moved with it',
  settings.characterCreationConnectionProfileId === 'conn-2',
  String(settings.characterCreationConnectionProfileId))
check('the map subsystems moved with it',
  settings.mapArchitectConnectionProfileId === 'conn-2'
    && settings.mapRuntimeConnectionProfileId === 'conn-2'
    && settings.mapEvolutionConnectionProfileId === 'conn-2',
  String(settings.mapArchitectConnectionProfileId))

// Asserting the settings is not enough — the request is what matters.
state.generations.length = 0
state.generationResponse = '[CHARACTER]\nQ2 (Bard)\n[/CHARACTER]'
const rolled = await rollCharacter({ className: 'Bard', genre: 'fantasy' })
const used = state.generations[state.generations.length - 1] as {
  connection_id?: string; model?: string
}
check('the roll went out on the new connection', rolled.ok && used?.connection_id === 'conn-2',
  `${used?.connection_id} / ${used?.model}`)
check('with the new connection\'s model',
  used?.model === SECOND_CONNECTION.model, String(used?.model))

console.log('\n── picking one pins it ──')
// Exactly what the settings UI sends for a `connection` field.
const pick = (key: string, value: string): Promise<void> => emitFrontendMessage(state, {
  type: 'settings:patch',
  patch: { [key]: value, [sourceKeyForProfileKey(key)]: 'profile' },
})

await pick('mapArchitectConnectionProfileId', 'conn-1')
await wait()
check('the pick survived the next sync',
  settings.mapArchitectConnectionProfileId === 'conn-1',
  String(settings.mapArchitectConnectionProfileId))
check('and its own source key was set, not the tracker\'s',
  settings.mapArchitectConnectionSource === 'profile'
    && settings.connectionProfileId === 'conn-2',
  `${settings.mapArchitectConnectionSource} / tracker ${settings.connectionProfileId}`)

await emitFrontendMessage(state, {
  type: 'settings:patch',
  patch: { connectionProfileId: 'conn-1', connectionSource: 'profile' },
})
await emitFrontendMessage(state, {
  type: 'settings:patch',
  patch: { connectionProfileId: 'conn-2', connectionSource: 'profile' },
})
await wait()
check('a pinned connection stops following the tracker',
  settings.mapArchitectConnectionProfileId === 'conn-1',
  String(settings.mapArchitectConnectionProfileId))
check('but unpinned ones still follow',
  settings.mapRuntimeConnectionProfileId === 'conn-2',
  String(settings.mapRuntimeConnectionProfileId))

console.log('\n── a connection that no longer exists ──')
// Silently sending with no model produced a provider 400 that named nothing.
state.connections.splice(0, state.connections.length, SECOND_CONNECTION)
let staleError = ''
try {
  const { ConnectionManagerRequestService } = await import('../src/compat/llm')
  const { invalidateConnectionCache } = await import('../src/compat/llm')
  invalidateConnectionCache()
  await ConnectionManagerRequestService.sendRequest('conn-gone', [
    { role: 'user', content: 'hi' },
  ])
} catch (error) {
  staleError = (error as Error).message
}
check('names the missing profile', /conn-gone/.test(staleError) && /no longer exists/.test(staleError),
  staleError)

console.log(`\n${failures === 0 ? 'connections test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
