/**
 * modules.ts — the Lorebook Agent's Modular Repertoire, and its connection.
 *
 *   bun tests/modules.ts
 *
 * Two things upstream exposes that the port did not.
 *
 * **The connection.** The agent has its own, defaulting to SillyTavern's "main
 * API". `router` was missing from `CONNECTION_PREFIXES`, so every agent pass
 * went out with no model and came back a 400. The pass logs its own failure and
 * the tracker carries on, so the only symptom was an agent that never wrote
 * anything on its own — while tool-driven writes kept working, which made it
 * look alive.
 *
 * **The record types.** `settings.routerModules` has been driving what the
 * agent records all along, with no way to see or change it. The rules are where
 * most of the behaviour lives: "ONLY record a quest if the player unambiguously
 * begins to pursue one" is one editable sentence.
 */

import { emitFrontendMessage, emitHostEvent, installFakeSpindle } from './fake-spindle'

const state = installFakeSpindle()
state.messages.set('chat-1', [{
  id: 'm1', chat_id: 'chat-1', index_in_chat: 0, is_user: true, role: 'user',
  name: 'You', content: 'We meet Bram the innkeeper in Khelt.', send_date: 0,
  swipe_id: 0, swipes: ['We meet Bram the innkeeper in Khelt.'], swipe_dates: [0],
  extra: {}, parent_message_id: null, branch_id: null, created_at: 0,
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

console.log('── the agent can actually reach a model ──')
check('the agent follows the tracker\'s connection',
  settings.routerConnectionSource === 'profile'
    && settings.routerConnectionProfileId === settings.connectionProfileId,
  `${settings.routerConnectionSource} / ${settings.routerConnectionProfileId}`)

settings.routerEnabled = true
state.generations.length = 0
state.generationResponse = '[[NPC: Bram | An innkeeper in Khelt. | bram, innkeeper]]'
const router = await import('../src/engine/router.js') as unknown as {
  runRouterPass: (options?: Record<string, unknown>) => Promise<unknown>
}
try {
  await router.runRouterPass({ force: true })
} catch (error) {
  check('the pass ran', false, (error as Error).message.slice(0, 90))
}
await wait(600)

check('the pass reached the model', state.generations.length > 0,
  `${state.generations.length} generation(s)`)
const sent = state.generations[0] as { model?: string; connection_id?: string }
check('with a model, not the 400 the port used to get',
  !!sent?.model, `${sent?.connection_id} / ${sent?.model}`)
check('and no error was logged',
  !state.logs.some(entry => entry.level === 'error'
    && /Missing or invalid required parameter/.test(entry.message)),
  state.logs.filter(e => e.level === 'error')[0]?.message?.slice(0, 80) ?? '')

console.log('\n── the record types ──')
const { listModules, patchModule, resetModule } = await import('../src/tracker/modules')
const modules = await listModules()
check('lists every shipped record type',
  ['npc', 'loc', 'fac', 'quest', 'event', 'world'].every(
    id => modules.some(m => m.id === id)),
  modules.map(m => m.id).join(', '))

const quest = modules.find(m => m.id === 'quest')!
check('carries the rule that shapes the agent',
  /unambiguously begins to pursue/.test(quest.instruction),
  quest.instruction.slice(0, 50))
check('and the field layout', quest.format.includes('Name'), quest.format)
check('starts as shipped', quest.isDefault)

console.log('\n── editing ──')
await patchModule('quest', { instruction: 'Record every rumour as a quest.' })
const edited = (await listModules()).find(m => m.id === 'quest')!
check('the rule changed', edited.instruction === 'Record every rumour as a quest.')
check('and is no longer marked as shipped', !edited.isDefault,
  'the panel offers Reset only once something changed')
check('the engine sees it',
  settings.routerModules.quest.instruction === 'Record every rumour as a quest.',
  'the agent reads settings.routerModules directly')

await patchModule('npc', { enabled: false })
check('a record type can be switched off',
  (await listModules()).find(m => m.id === 'npc')!.enabled === false)
await patchModule('npc', { enabled: true })

// Switching one off must not wipe the rest of its definition, or the agent
// gets a record type with no tag when it is switched back on.
check('switching off kept the rest of the definition',
  !!settings.routerModules.npc.tag && !!settings.routerModules.npc.instruction,
  JSON.stringify(Object.keys(settings.routerModules.npc)))

console.log('\n── resetting ──')
await resetModule('quest')
const restored = (await listModules()).find(m => m.id === 'quest')!
check('the shipped rule came back',
  /unambiguously begins to pursue/.test(restored.instruction),
  restored.instruction.slice(0, 50))
check('and it reads as shipped again', restored.isDefault)

console.log('\n── through the panel ──')
state.toFrontend.length = 0
await emitFrontendMessage(state, { type: 'modules:read' })
await wait()
const pushed = state.toFrontend.find(m => (m as any).type === 'modules:state') as any
check('the panel is sent the record types', (pushed?.modules ?? []).length >= 6,
  String((pushed?.modules ?? []).length))

await emitFrontendMessage(state, {
  type: 'modules:patch', id: 'event', instruction: 'Only major events.',
})
await wait()
check('a panel edit reaches the engine',
  settings.routerModules.event.instruction === 'Only major events.')

console.log('\n── the lookback mode ──')
// Three choices stored as two booleans, which no single control can drive.
const { lookbackModeFrom, lookbackModeTo } = await import('../src/shared/settings-schema')
check('reads as "since last run" by default',
  lookbackModeFrom(settings) === 'sinceRun', lookbackModeFrom(settings))

for (const mode of ['sinceRun', 'sinceUser', 'fixed']) {
  Object.assign(settings, lookbackModeTo(mode))
  check(`${mode} round-trips`, lookbackModeFrom(settings) === mode,
    lookbackModeFrom(settings))
}

state.toFrontend.length = 0
await emitFrontendMessage(state, {
  type: 'settings:patch', patch: { routerLookbackMode: 'sinceUser' },
})
await wait()
check('the form writes the pair, not the derived key',
  settings.routerLookbackSinceLastRun === false
    && settings.routerLookbackSinceLastUser === true
    && settings.routerLookbackMode === undefined,
  'a stored derived key would be a setting nothing reads')
const synced = state.toFrontend.find(m => (m as any).type === 'settings:sync') as any
check('and the form is told the derived value back',
  synced?.settings?.routerLookbackMode === 'sinceUser',
  String(synced?.settings?.routerLookbackMode))

console.log('\n── settings that only matter once something is rebuilt ──')
// `refreshQuestPrompt` and `rebuildNpcInstructionIfNeeded` read like DOM chores
// and are not — both rewrite stored prompt text. Registered as no-ops, they
// left two settings that changed nothing at all.
const { refreshQuestPrompt } = await import('../src/tracker/stock-prompts')

settings.syspromptModules.questsDeadlines = true
settings.syspromptModules.questsFrustration = true
await refreshQuestPrompt(settings)
const withDeadlines = String(settings.stockPrompts?.quests ?? '')
check('the quest prompt mentions deadlines when they are on',
  /DEADLINE/.test(withDeadlines), `${withDeadlines.length} chars`)

settings.syspromptModules.questsDeadlines = false
await refreshQuestPrompt(settings)
const withoutDeadlines = String(settings.stockPrompts?.quests ?? '')
check('turning deadlines off takes them out of the prompt',
  !/DEADLINE/.test(withoutDeadlines),
  `${withDeadlines.length} -> ${withoutDeadlines.length} chars`)

// Rebuilt from the shipped default each time, so toggling back restores the
// original rather than leaving whatever the regexes last produced.
settings.syspromptModules.questsDeadlines = true
await refreshQuestPrompt(settings)
check('and turning them back on restores the original text',
  String(settings.stockPrompts?.quests) === withDeadlines,
  'rebuilt from the default, not edited in place')

await emitFrontendMessage(state, {
  type: 'settings:patch', patch: { 'syspromptModules.questsDeadlines': false },
})
await wait()
check('a settings change rebuilds it without being asked',
  !/DEADLINE/.test(String(settings.stockPrompts?.quests ?? '')),
  'the toggle is an input to the prompt, not the prompt')

console.log(`\n${failures === 0 ? 'modules test passed' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
