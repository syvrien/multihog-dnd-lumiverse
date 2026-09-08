/**
 * smoke.ts — boot the backend against the fake host and report what happens.
 *
 *   bun tests/smoke.ts
 *
 * This is the first check that actually *executes* the ported engine. The
 * bundler only proves the module graph resolves; this proves module-scope code
 * runs, the compat globals are in place before the engine touches them, and the
 * interceptor survives a round trip.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()

// Seed a chat so the mirror has something to attach to.
state.messages.set('chat-1', [
  { id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user', name: 'You', content: 'I open the door.', send_date: 0, swipe_id: 0, swipes: ['I open the door.'], swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0 },
  { id: 'm2', chat_id: 'chat-1', index_in_chat: 1, is_user: false, role: 'assistant', name: 'Narrator', content: 'The hinges groan.', send_date: 0, swipe_id: 0, swipes: ['The hinges groan.'], swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0 },
])

console.log('booting backend…\n')
await import('../src/backend')

// boot() is async and fire-and-forget; give it a tick to settle.
await new Promise(resolve => setTimeout(resolve, 250))

const byLevel = (level: string): string[] =>
  state.logs.filter(entry => entry.level === level).map(entry => entry.message)

console.log('── logs ──')
for (const entry of state.logs) console.log(`  [${entry.level}] ${entry.message}`)

console.log('\n── host wiring ──')
console.log(`  event subscriptions : ${[...state.listeners.keys()].join(', ') || '(none)'}`)
console.log(`  interceptors        : ${state.interceptors.length}`)
console.log(`  messages to frontend: ${state.toFrontend.length}`)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n── checks ──')
check('chat mirror attached', state.listeners.has('CHAT_CHANGED'))

// Operator-scoped: nothing user-scoped may run until an event names a user.
// Boot used to call chats.getActive() / world_books.list() / connections.list()
// with no user, and the host rejected all three.
check('no user-scoped work before a user is known',
  state.userStorage.size === 0, `${state.userStorage.size} key(s) written`)

await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-1' })
await new Promise(resolve => setTimeout(resolve, 250))

check('user resolved from the event',
  state.logs.some(entry => entry.message.includes('acting for user user-1')))

// Settings load is a read, so nothing is on disk yet — what matters is that
// the engine's tree is populated and that saving lands under *this user's* key.
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, unknown>
}
check('engine settings available after user resolved',
  Object.keys(getSettings()).length > 0, `${Object.keys(getSettings()).length} keys`)

const { saveSettings } = await import('../src/compat/settings-store')
await saveSettings()
check('settings persist under the user\'s own scope',
  [...state.userStorage.keys()].some(key => key.startsWith('user-1:')),
  [...state.userStorage.keys()].join(', ') || 'nothing written')
check('interceptor registered', state.interceptors.length === 1)

console.log('\n── settings patching ──')
// The settings UI addresses grouped settings by dotted path. A plain
// Object.assign would create a literal `"syspromptModules.loot"` key the engine
// never reads — the toggle would appear to work and change nothing.
await emitFrontendMessage(state, {
  type: 'settings:patch',
  patch: { 'syspromptModules.loot': false, maxTokens: 512 },
})
await new Promise(resolve => setTimeout(resolve, 150))

const engineSettings = getSettings()
const modules = engineSettings.syspromptModules as Record<string, unknown> | undefined
check('dotted patch reached the nested key', modules?.loot === false, String(modules?.loot))
check('no literal dotted key was created',
  !Object.prototype.hasOwnProperty.call(engineSettings, 'syspromptModules.loot'))
check('flat patch still works', engineSettings.maxTokens === 512, String(engineSettings.maxTokens))

const syncMessage = state.toFrontend
  .filter((m): m is { type: string; connections?: unknown[] } =>
    !!m && typeof m === 'object' && (m as { type?: string }).type === 'settings:sync')
  .pop()
check('replied with settings:sync carrying the connection list',
  Array.isArray(syncMessage?.connections) && syncMessage.connections.length > 0,
  JSON.stringify(syncMessage?.connections))

// Drive the interceptor the way the host would.
if (state.interceptors.length) {
  const { handler } = state.interceptors[0]
  const prompt = [
    { role: 'system', content: 'You are the narrator.' },
    { role: 'user', content: 'I open the door.' },
  ]
  try {
    const result = await handler(prompt, {
      chatId: 'chat-1', generationType: 'normal', userId: state.userId,
    })
    check('interceptor returned a message array', Array.isArray(result), `got ${typeof result}`)
    check('interceptor preserved the prompt', Array.isArray(result) && result.length >= prompt.length,
      `in ${prompt.length}, out ${Array.isArray(result) ? result.length : '?'}`)
  } catch (error) {
    check('interceptor ran', false, (error as Error).message)
  }
}

// A chat switch must not throw.
try {
  await emitHostEvent(state, 'CHAT_CHANGED', { chatId: 'chat-2' })
  check('chat switch handled', true)
} catch (error) {
  check('chat switch handled', false, (error as Error).message)
}

// Checked last, not first. `adaptInterceptor` logs and swallows engine throws,
// so an error raised while running the interceptor exists only in the log — an
// earlier version of this file asserted before that point and passed green
// while the interceptor was in fact failing on a missing `localStorage`.
const errors = byLevel('error')
check('no errors logged', errors.length === 0, errors[0] ?? '')

console.log(`\n${failures === 0 ? 'smoke test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
