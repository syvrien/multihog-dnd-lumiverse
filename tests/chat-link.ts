/**
 * chat-link.ts — one campaign per chat, or one campaign for every chat.
 *
 *   bun tests/chat-link.ts
 *
 * Upstream's Chat-Linked Mode. The engine carried `chatLinkEnabled` all along,
 * but nothing in the port could set it, and the switch path ignored it: the
 * engine's loader and saver do not check the flag themselves — upstream gates
 * them at the call site, in `index.js`, which the port replaces. So "off" was
 * neither reachable nor real. This checks that it is now both, and that
 * turning it back on inside a chat with a different saved campaign asks which
 * one to keep instead of silently choosing.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
const msg = (id: string, chatId: string): Record<string, unknown> => ({
  id, chat_id: chatId, index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'x', send_date: 0, swipe_id: 0, swipes: ['x'],
  swipe_dates: [0], extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
})
for (const id of ['chat-a', 'chat-b']) state.messages.set(id, [msg('m-' + id, id)] as never)

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
  await wait(300)
}
const { getSettings } = await import('../src/engine/state-manager.js') as {
  getSettings: () => Record<string, any>
}
const settings = getSettings()
const { writeMemo } = await import('../src/tracker/direct-prompt')
const who = (): string => String(settings.currentMemo).match(/(\w+) \(/)?.[1] ?? '(none)'
const patch = (value: Record<string, unknown>): Promise<void> =>
  emitFrontendMessage(state, { type: 'settings:patch', patch: value })
const lastToast = (): string =>
  String((state.toFrontend.filter(m => (m as any).type === 'toast').at(-1) as any)?.message ?? '')

console.log('── on by default: each chat its own campaign ──')
await go('chat-a')
await writeMemo('[CHARACTER]\nSyg (Resonator)\nHP: 8/8\n[/CHARACTER]')
settings.customPortraits = { Syg: '/img/syg.png' }
await go('chat-b')
await writeMemo('[CHARACTER]\nBram (Innkeeper)\nHP: 6/6\n[/CHARACTER]')
settings.customPortraits = { Bram: '/img/bram.png' }
await go('chat-a')
check('chat A holds its own campaign', who() === 'Syg', who())
check('the toggle is offered in the settings', await (async () => {
  const { SETTINGS_SCHEMA } = await import('../src/shared/settings-schema')
  return SETTINGS_SCHEMA.some(area => (area.fields ?? []).some(f => f.key === 'chatLinkEnabled'))
})())

console.log('\n── turned off: one campaign follows every chat ──')
settings.quests = [{ title: 'Find the ferryman' }]
await patch({ chatLinkEnabled: false })
await wait()
check('the setting took', settings.chatLinkEnabled === false)
check('and said so', /follows you across every chat/.test(lastToast()), lastToast())
await go('chat-b')
// The engine's loader would happily project chat B's saved campaign; with
// the link off it must not be asked to.
check('switching keeps the shared campaign, not the chat’s saved one', who() === 'Syg', who())
check('portraits still belong to each chat',
  settings.customPortraits?.Bram === '/img/bram.png' && !settings.customPortraits?.Syg,
  JSON.stringify(settings.customPortraits))
check('and what belongs to a scene, not a campaign, is reset', (settings.quests ?? []).length === 0,
  `${(settings.quests ?? []).length} quest(s)`)
check('chat B’s own saved campaign is left untouched for later',
  /Bram/.test(String(settings.chatStates?.['chat-b']?.currentMemo ?? '')))

console.log('\n── turned back on in a chat whose saved campaign differs ──')
// Live is Syg (shared), chat B saved Bram: a real choice between two sets of
// work, which upstream asks about rather than guessing.
state.toFrontend.length = 0
const answer = async (result: unknown): Promise<string> => {
  for (let i = 0; i < 100; i++) {
    const open = state.toFrontend.find(m => (m as any).type === 'popup:open') as any
    if (open) {
      await emitFrontendMessage(state, { type: 'popup:result', requestId: open.requestId, result })
      return JSON.stringify(open.options ?? {})
    }
    await wait(10)
  }
  return ''
}
void patch({ chatLinkEnabled: true })
const asked = await answer(null)
await wait()
check('it asks which campaign to keep', /Restore/.test(asked) && /Overwrite/.test(asked), asked.slice(0, 120))
check('with a way out', /Cancel/.test(asked))
check('and cancelling leaves the link off', settings.chatLinkEnabled === false)
check('without touching either campaign', who() === 'Syg'
  && /Bram/.test(String(settings.chatStates?.['chat-b']?.currentMemo ?? '')))

state.toFrontend.length = 0
void patch({ chatLinkEnabled: true })
await answer(1) // AFFIRMATIVE — Restore
await wait()
check('Restore turns it on with the chat’s saved campaign', settings.chatLinkEnabled === true && who() === 'Bram', who())
check('keeping the displaced one in history',
  (settings.memoHistory ?? []).some((m: unknown) => /Syg/.test(String(m))),
  `${(settings.memoHistory ?? []).length} snapshot(s)`)

console.log('\n── Overwrite keeps the session instead ──')
await patch({ chatLinkEnabled: false })
await wait()
await go('chat-a') // shared campaign stays Bram
state.toFrontend.length = 0
void patch({ chatLinkEnabled: true })
await answer(0) // NEGATIVE — Overwrite
await wait()
check('Overwrite turns it on keeping the current campaign', settings.chatLinkEnabled === true && who() === 'Bram', who())
check('and saves it to this chat', /Bram/.test(String(settings.chatStates?.['chat-a']?.currentMemo ?? '')))

const errors = state.logs.filter(entry => entry.level === 'error')
console.log('\n── errors ──')
if (!errors.length) console.log('  (none)')
for (const entry of errors) console.log(`  ${entry.message.slice(0, 120)}`)
check('no errors', errors.length === 0, errors[0]?.message ?? '')

console.log(`\n${failures === 0 ? 'chat link test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
